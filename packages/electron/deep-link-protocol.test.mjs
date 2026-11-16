import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEEP_LINK_PROTOCOLS, isAppDeepLink } from './deep-link-protocol.mjs';

describe('external deep-link compatibility', () => {
  it('routes workspace links by local runtime across window order, loading and missing windows', async () => {
    const vm = await import('node:vm');
    const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
    for (const packaged of [false, true]) {
      const windows = [];
      const events = [];
      const makeWindow = (runtime, extra = {}) => {
        const window = {
          __yuriLabel: 'window', __yuriRuntimeConfig: runtime,
          isDestroyed: () => false, isMinimized: () => true,
          restore() { this.restored = true; }, show() {}, focus() { this.focused = true; },
          webContents: { isLoading: () => false }, ...extra,
        };
        windows.push(window);
        return window;
      };
      const remote = makeWindow({ apiBaseUrl: 'https://remote.example' });
      makeWindow({ apiBaseUrl: 'http://localhost:3000', relayHostId: 'relay' });
      makeWindow({ apiBaseUrl: 'http://localhost:3000' }, { __yuriMiniChat: true });
      const local = makeWindow({ apiBaseUrl: 'http://localhost:3000' });
      const queue = [];
      let created;
      const context = vm.createContext({
        BrowserWindow: { getAllWindows: () => windows },
        state: { mainWindow: remote, sidecarUrl: 'http://localhost:3000', localUiOrigin: 'http://localhost:5173' },
        sameOrigin: (a, b) => Boolean(a && b && new URL(a).origin === new URL(b).origin),
        shouldUsePackagedUi: () => packaged,
        buildPackagedUiUrl: () => 'yuri-ui://app/index.html',
        nextWindowLabel: () => 'new-local', readDesktopLocalClientToken: () => 'local-test-token',
        createBrowserWindow: (options) => {
          created = options;
          return makeWindow(options.runtimeConfig, { webContents: { isLoading: () => true } });
        },
        initialStartupComplete: true, pendingDeepLinks: queue,
        schedulePendingDeepLinkFlush() {}, log: { info() {}, warn() {} },
        resolveMainWindowTarget: () => remote,
        emitToWindow: (window, event, detail) => events.push({ window, event, detail }),
      });
      vm.runInContext(source.slice(source.indexOf('const isLocalWorkspaceDeepLink ='), source.indexOf('const flushPendingDeepLinks ='))
        + '\nglobalThis.dispatch = dispatchDeepLink;', context);
      const link = { raw: 'yuri://open-project?directory=/workspace', type: 'open-project', directory: '/workspace' };
      for (let i = 0; i < 2; i++) {
        context.dispatch(link);
        expect(events.at(-1).window).toBe(local);
        windows.reverse();
      }
      expect(local.focused && local.restored).toBe(true);
      expect(remote.focused).toBeUndefined();
      local.isDestroyed = () => true;
      context.dispatch(link);
      expect(created.url).toBe(packaged ? 'yuri-ui://app/index.html' : 'http://localhost:5173');
      expect(created.runtimeConfig).toEqual({ apiBaseUrl: 'http://localhost:3000', clientToken: 'local-test-token', requestHeaders: {} });
      expect(queue).toHaveLength(1);
      const fresh = windows.at(-1);
      fresh.webContents.isLoading = () => false;
      context.dispatch(queue.shift());
      expect(events.at(-1)).toEqual({ window: fresh, event: 'yuri:open-project', detail: { projectPath: '/workspace' } });
      expect(fresh.focused).toBe(true);
    }
  });

  it('routes external session links to the probed owner window or the local Hub with the outcome', async () => {
    const vm = await import('node:vm');
    const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
    const events = [];
    const makeWindow = (runtime, extra = {}) => ({
      __yuriLabel: 'window', __yuriRuntimeConfig: runtime,
      isDestroyed: () => false, isMinimized: () => false,
      restore() {}, show() {}, focus() { this.focused = true; },
      webContents: { isLoading: () => false }, ...extra,
    });
    const remote = makeWindow({ apiBaseUrl: 'https://remote.example' });
    const local = makeWindow({ apiBaseUrl: 'http://localhost:3000' });
    const mini = makeWindow({ apiBaseUrl: 'http://localhost:3000' }, { __yuriMiniChat: true });
    const restricted = makeWindow({ apiBaseUrl: 'http://localhost:3000' });
    const windows = [remote, mini, local, restricted];
    const queue = [];
    let answer;
    const probed = [];
    const context = vm.createContext({
      BrowserWindow: { getAllWindows: () => windows },
      state: { mainWindow: remote, sidecarUrl: 'http://localhost:3000' },
      sameOrigin: (a, b) => Boolean(a && b && new URL(a).origin === new URL(b).origin),
      guiPluginHost: { isWindowOnly: (contents) => contents === restricted.webContents },
      sessionLinkProbe: { locate: async (candidates, id) => { probed.push({ candidates, id }); return answer(); } },
      initialStartupComplete: false, pendingDeepLinks: queue,
      schedulePendingDeepLinkFlush() {}, log: { info() {}, warn() {} },
      resolveMainWindowTarget: () => remote,
      emitToWindow: (window, event, detail) => events.push({ window, event, detail }),
    });
    vm.runInContext(source.slice(source.indexOf('const isLocalWorkspaceDeepLink ='), source.indexOf('const flushPendingDeepLinks ='))
      + '\nglobalThis.dispatch = dispatchDeepLink;', context);
    const link = { raw: 'yuri://session/ses_1?directory=%2Fsrv', type: 'session', value: 'ses_1', directory: '/srv' };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    context.dispatch(link);
    expect(queue).toEqual([link]);
    expect(probed).toEqual([]);
    vm.runInContext('initialStartupComplete = true;', context);

    answer = () => ({ outcome: 'found', window: remote, directory: '/data/repo' });
    context.dispatch(queue.shift());
    await settle();
    expect(probed[0].id).toBe('ses_1');
    expect(probed[0].candidates).toEqual([remote, local]);
    expect(events.at(-1)).toEqual({ window: remote, event: 'yuri:open-session-link', detail: { sessionId: 'ses_1', directory: '/data/repo' } });
    expect(remote.focused).toBe(true);

    for (const [outcome, detail] of [
      ['not-found', { sessionId: 'ses_1', directory: '/srv' }],
      ['unconfirmed', { sessionId: 'ses_1', directory: '/srv', probe: 'unconfirmed' }],
      ['ambiguous', { sessionId: 'ses_1', directory: '/srv', probe: 'ambiguous' }],
    ]) {
      answer = () => ({ outcome });
      context.dispatch(link);
      await settle();
      expect(events.at(-1)).toEqual({ window: local, event: 'yuri:open-session-link', detail });
    }

    let release;
    answer = () => new Promise((resolve) => { release = () => resolve({ outcome: 'found', window: remote, directory: '/stale' }); });
    context.dispatch(link);
    const stale = release;
    answer = () => ({ outcome: 'not-found' });
    context.dispatch(link);
    await settle();
    stale();
    await settle();
    expect(events.at(-1).detail).toEqual({ sessionId: 'ses_1', directory: '/srv' });

    const before = probed.length;
    context.dispatch({ type: 'session', value: 'ses_internal' });
    expect(probed).toHaveLength(before);
    expect(events.at(-1)).toEqual({ window: remote, event: 'yuri:open-session-link', detail: { sessionId: 'ses_internal', directory: undefined } });
  });

  it.each(['yuri', 'openchamber', 'openchambery'])('admits %s without rewriting route, scope or payload', (scheme) => {
    const link = `${scheme}://connect?v=2&p=opaque%2Bpayload%2Fvalue`;
    const args = ['/path/to/app', '--flag', link];
    expect(args.filter(isAppDeepLink)).toEqual([link]);
    expect(isAppDeepLink(`${scheme.toUpperCase()}://new-session?directory=%2Fworkspace`)).toBe(true);
    expect(isAppDeepLink(`${scheme}://session/session_1?directory=%2Fa%20b`)).toBe(true);
  });

  it('rejects unrelated URLs, nested schemes, internal resources and malformed input', () => {
    for (const value of [null, undefined, '', 'not a URL', 'https://example.com/?next=yuri://settings',
      'yuri-ui://app', 'yuri-asset://stream/id', 'yuri-other://session/id', 'yuri://']) {
      expect(isAppDeepLink(value)).toBe(false);
    }
  });

  it('packages every accepted scheme in the desktop installer', () => {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    expect(pkg.build.protocols.schemes).toEqual(DEEP_LINK_PROTOCOLS);
  });

  it('registers the same external schemes in both mobile shells', () => {
    const plist = readFileSync(new URL('../mobile/ios/App/App/Info.plist', import.meta.url), 'utf8');
    const schemes = plist.match(/<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '';
    const ios = [...schemes.matchAll(/<string>([^<]+)<\/string>/g)].map((match) => match[1]);
    const manifest = readFileSync(new URL('../mobile/android/app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
    const android = [...manifest.matchAll(/<data android:scheme="([^"]+)"/g)].map((match) => match[1]);
    expect(ios).toEqual(DEEP_LINK_PROTOCOLS);
    expect(android).toEqual(DEEP_LINK_PROTOCOLS);
  });
});
