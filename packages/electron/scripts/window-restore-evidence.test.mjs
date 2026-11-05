import { expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const electronDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test.runIf(process.env.YURI_WINDOW_RESTORE_EVIDENCE === '1').each(
  ['HMR', 'bundled'].flatMap(mode => [{ mode, relay: false }, { mode, relay: true }]),
)('real Electron restores two primary windows and the switched instance ($mode, Relay: $relay)', { timeout: 30000 }, async ({ mode, relay }) => {
  const root = await mkdtemp(path.join(tmpdir(), 'yuri-window-restore-'));
  const script = path.join(root, 'fixture.mjs');
  const fixture = `
    import { app, BrowserWindow, ipcMain, protocol, screen } from 'electron';
    import fs from 'node:fs';
    import path from 'node:path';
    import os from 'node:os';
    import { createServer } from 'node:http';
    import { createSettingsStore } from ${JSON.stringify(new URL('../settings-store.mjs', import.meta.url).href)};
    import { isGuiPluginUiUrl } from ${JSON.stringify(new URL('../gui-plugin-origin.mjs', import.meta.url).href)};
    import { getMenuLabels, normalizeMenuLocale } from ${JSON.stringify(new URL('../menu-i18n.mjs', import.meta.url).href)};
    const root = process.argv[2], mode = process.argv[3], stage = process.argv[4];
    app.setPath('userData', path.join(root, 'profile'));
    protocol.registerSchemesAsPrivileged([{ scheme: 'yuri-ui', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
    app.whenReady().then(async () => {
    const html = '<!doctype html><body>window restore fixture<script>window.firstBootOutcome = window.__YURI_DESKTOP_BOOT__?.getOutcome(); window.firstApiBase = window.__YURI_API_BASE_URL__; window.firstRelayHost = window.__YURI_RELAY_HOST_ID__ || "";</script>';
    protocol.handle('yuri-ui', () => new Response(html, { headers: { 'content-type': 'text/html' } }));
    const serve = async () => {
      const server = createServer((_req, res) => res.end(html));
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      return server;
    };
    const localServer = await serve(), remoteServer = await serve();
    const localUrl = 'http://127.0.0.1:' + localServer.address().port;
    const remoteUrl = 'http://127.0.0.1:' + remoteServer.address().port;
    const localUiUrl = mode === 'bundled' ? 'yuri-ui://app/index.html' : localUrl;
    const store = createSettingsStore({ filePath: path.join(root, 'settings.json') });
    const state = { localOrigin: localUrl, localUiOrigin: localUrl, sidecarUrl: localUrl, apiBaseUrl: localUrl,
      bootOutcome: { target: 'local', status: 'ok' }, focusedWindowIds: new Set(),
      windowGeometryTimers: new Map(), windowGeometryRevisions: new Map(), webviewZoomFactor: 1 };
    const host = { id: 'remote-fixture', url: remoteUrl, clientToken: 'fixture-only-token',
      ...(${JSON.stringify(relay)} ? { relay: { serverId: 'fixture-server', relayUrl: 'wss://relay.invalid', hostEncPubJwk: {} } } : {}) };
    const source = fs.readFileSync(${JSON.stringify(path.join(electronDir, 'main.mjs'))}, 'utf8');
    const slice = (a, b) => source.slice(source.indexOf(a), source.indexOf(b));
    let label = 1;
    const noop = () => {};
    const context = {
      state, URL, Number, process, fs, path, os, app, BrowserWindow, screen, setTimeout, clearTimeout, ipcMain, isGuiPluginUiUrl,
      readSettingsRoot: store.readRoot, mutateSettingsRoot: store.mutate,
      readDesktopHostsConfig: () => ({ hosts: [host], defaultHostId: 'local' }),
      readDesktopLocalClientToken: () => 'fixture-local-token',
      resourceRoot: () => ${JSON.stringify(path.join(electronDir, 'resources'))}, getMenuLabels, normalizeMenuLocale,
      isLocalRuntimeUrl: url => url === localUrl, normalizeHostUrl: url => url,
      sameOrigin: (a, b) => Boolean(a && b && new URL(a).origin === new URL(b).origin),
      sanitizeRuntimeRequestHeaders: headers => headers,
      shouldUsePackagedUi: () => mode === 'bundled', isDev: true,
      __dirname: ${JSON.stringify(electronDir)}, LOCAL_HOST_ID: 'local', UI_PROTOCOL: 'yuri-ui',
      MIN_WINDOW_WIDTH: 350, MIN_WINDOW_HEIGHT: 400, MIN_RESTORE_WINDOW_WIDTH: 350, MIN_RESTORE_WINDOW_HEIGHT: 400,
      APP_USER_MODEL_ID: 'dev.yuri.window-fixture', getWindowIconPath: noop, macosMajorVersion: () => 0,
      trackMacWindowVibrancy: noop, buildInitScript: () => '', shouldUseSameOriginDevProxy: () => false,
      nextWindowLabel: () => 'main-' + (++label), log: { warn: noop, error: console.error },
      emitToWindow: noop, setMacVibrancyReady: noop, scheduleMacVibrancyReady: noop,
      shouldHideMainWindowToTray: () => false, resolveMainWindowTarget: noop, performConfirmedQuit: noop,
      isPackagedUiUrl: url => url.protocol === 'yuri-ui:', sameUrlIdentity: (a, b) => new URL(a).origin === new URL(b).origin,
      shell: { openExternal: async () => {} }, applyWebviewZoomFactor: noop,
      resolveWindowInitScript: () => null, schedulePendingDeepLinkFlush: noop,
      presentBrowserWindow: win => win.show(), navigateWindow: (win, url) => {
        win.__fixtureLoaded = win.loadURL(url);
        return win.__fixtureLoaded;
      },
      guiPluginHost: { invalidateWindow: noop, isWindowOnly: () => false }, viewExportHost: { invalidateOwner: noop },
      isGuiPluginWindow: event => event.senderFrame === event.sender.mainFrame
        && Boolean(BrowserWindow.fromWebContents(event.sender)) && isGuiPluginUiUrl(event.sender.getURL(), [localUrl]),
      sshManager: { readInstances: () => ({ instances: [] }) },
      probeHostWithTimeout: async () => ({ status: 'ok' }),
    };
    const setup = new Function(...Object.keys(context), [
      slice('const readWindowState =', 'const buildHealthUrl ='),
      slice('const buildRendererRuntimeConfig =', 'const readDesktopLocalClientToken ='),
      slice('const computeBootOutcome =', 'const buildStartupSplashHtml ='),
      slice('const buildStartupSplashHtml =', 'const isBenignNavigationAbort ='),
      slice('const createBrowserWindow =', 'const activateMainWindow ='),
      slice('const activateMainWindow =', 'const openMainWindow ='),
      slice('const getWindowRuntimeConfig =', 'const createMiniChatWindow ='),
      slice('const resolveDesktopStartupTarget =', 'const restoreAdditionalDesktopWindows ='),
      slice("ipcMain.on('yuri:window-runtime'", "ipcMain.handle('yuri:invoke'"),
      'return { create: createBrowserWindow, activate: activateMainWindow, save: writeWindowState, read: readWindowStates, resolve: resolveDesktopStartupTarget,',
      'setRestoring: value => { restoringWindowSession = value; }, freeze: () => { windowSessionFrozen = true; },',
      'invoke: async (browserWindow, command, args) => { switch(command) {' + slice("    case 'desktop_window_runtime_set':", "    case 'desktop_hosts_get':") + '} } };',
    ].join('\\n'));
    Object.assign(context, setup(...Object.values(context)));
    let written;
    ipcMain.handle('yuri:invoke', async (event, command, args) => {
      if (event.senderFrame !== event.sender.mainFrame) throw Error('not main frame');
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await context.invoke(win, command, args);
      written?.();
      return result;
    });
    const loaded = win => win.__fixtureLoaded || Promise.resolve();
    try {
      context.setRestoring(true);
      if (stage === 'save') {
        const main = context.create({ label: 'main', url: new URL('/session/first', localUiUrl).href, runtimeConfig: { apiBaseUrl: localUrl, hostId: 'local' } });
        state.mainWindow = main;
        const second = context.create({ label: 'main-2', url: new URL('/assistant/second', localUiUrl).href, runtimeConfig: { apiBaseUrl: localUrl, hostId: 'local' } });
        await Promise.all([loaded(main), loaded(second)]);
        main.setBounds({ x: 25, y: 40, width: 900, height: 650 });
        second.setBounds({ x: 80, y: 70, width: 800, height: 600 });
        context.setRestoring(false);
        const changed = new Promise(resolve => { written = resolve; });
        await main.webContents.executeJavaScript('window.dispatchEvent(new CustomEvent("yuri:runtime-endpoint-changed", { detail: { runtimeKey: "host:remote-fixture", apiBaseUrl: ' + JSON.stringify(remoteUrl) + ' } }))');
        await changed;
        await context.save(main);
        fs.writeFileSync(path.join(root, 'before.json'), JSON.stringify(context.read()));
      } else {
        const entries = context.read();
        const windows = [];
        for (const [index, entry] of entries.entries()) {
          if (index === 0) {
            state.mainWindow = context.create({ label: 'main', restoreGeometry: true, url: null });
            await loaded(state.mainWindow);
            const status = await state.mainWindow.webContents.executeJavaScript('document.querySelector(".startup-status").textContent');
            expectStatus(status);
          }
          const target = await context.resolve(entry.hostId, { localUrl, localUiUrl, localOrigin: localUrl });
          const url = new URL(entry.route, mode === 'bundled' ? localUiUrl : target.initialUrl).href;
          const win = index === 0 ? await context.activate(url, localUrl, target.bootOutcome, target)
            : context.create({ label: 'main-' + (index + 1), savedState: entry, url, runtimeConfig: target });
          windows.push(win);
          if (index === 0) state.mainWindow = win;
        }
        await Promise.all(windows.map(loaded));
        fs.writeFileSync(path.join(root, 'after.json'), JSON.stringify(await Promise.all(windows.map(async win => ({
          hostId: win.__yuriHostId, route: new URL(win.webContents.getURL()).pathname, ...win.getNormalBounds(),
          preload: await win.webContents.executeJavaScript('Boolean(window.__YURI_DESKTOP__)'),
          firstBootOutcome: await win.webContents.executeJavaScript('window.firstBootOutcome'),
          firstApiBase: await win.webContents.executeJavaScript('window.firstApiBase'),
          firstRelayHost: await win.webContents.executeJavaScript('window.firstRelayHost'),
        })))));
      }
      context.freeze();
      state.quitRequested = true;
      BrowserWindow.getAllWindows().forEach(win => win.destroy());
      app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
    }).catch(error => { console.error(error); app.exit(1); });
    function expectStatus(status) { if (!status || status !== getMenuLabels(normalizeMenuLocale(app.getLocale())).startupConnectingRemote) throw new Error('Missing remote startup status'); }
  `;
  try {
    await writeFile(script, fixture);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    for (const stage of ['save', 'restore']) {
      await new Promise((resolve, reject) => {
        const child = spawn(createRequire(import.meta.url)('electron'), [script, root, mode, stage, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], { env, stdio: 'pipe', windowsHide: true });
        let stderr = '';
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.stdout.on('data', chunk => { stderr += chunk; });
        const timer = setTimeout(() => { child.kill(); reject(new Error('Window evidence timed out: ' + stderr)); }, 12000);
        child.on('error', reject);
        child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(stderr)); });
      });
    }
    const before = JSON.parse(await readFile(path.join(root, 'before.json'), 'utf8'));
    const after = JSON.parse(await readFile(path.join(root, 'after.json'), 'utf8'));
    expect(before.map(entry => entry.hostId)).toEqual(['remote-fixture', 'local']);
    expect(after).toHaveLength(2);
    for (const [index, entry] of before.entries()) {
      expect(after[index]).toMatchObject({ hostId: entry.hostId, route: entry.route, width: entry.width, height: entry.height, x: entry.x, y: entry.y });
      expect(after[index].preload).toBe(true);
      expect(after[index].firstBootOutcome).toMatchObject({ target: entry.hostId === 'local' ? 'local' : 'remote', status: 'ok' });
      expect(after[index].firstApiBase).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect(after[index].firstRelayHost).toBe(relay && entry.hostId !== 'local' ? entry.hostId : '');
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
