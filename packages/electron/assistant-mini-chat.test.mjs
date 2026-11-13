import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
const makeHarness = (packaged = false) => {
  const windows = [];
  const events = [];
  class Window extends EventEmitter {
    constructor(options = {}) {
      super();
      this.options = options; this.id = windows.length + 1;
      this.__yuriLabel = 'test';
      this.webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler() {}, executeJavaScript: async () => {}, isLoading: () => false });
      this.restore = vi.fn(); this.show = vi.fn(); this.focus = vi.fn(); this.setAlwaysOnTop = vi.fn();
      windows.push(this);
    }
    isDestroyed() { return Boolean(this.destroyed); }
    isMinimized() { return true; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    static getAllWindows() { return windows; }
  }
  const state = {
    localOrigin: 'http://localhost:3000', localUiOrigin: 'http://localhost:5173', sidecarUrl: 'http://localhost:3000',
    apiBaseUrl: 'http://localhost:3000', clientToken: '', requestHeaders: {}, miniChatWindowsBySession: new Map(),
  };
  const navigateWindow = vi.fn(async (window, url) => { window.url = url; });
  const createAdditionalWindow = vi.fn(async (url, runtime) => {
    const window = new Window(); window.url = url; window.__yuriRuntimeConfig = runtime; return window;
  });
  const context = vm.createContext({
    URL, BrowserWindow: Window, state, process: { platform: 'linux' }, os: { homedir: () => '/home/user' },
    normalizeHostUrl: (url) => url.replace(/\/$/, ''), sanitizeClientTokenForStorage: (token) => token || '',
    sanitizeRuntimeRequestHeaders: (headers) => headers || {}, shouldUsePackagedUi: () => packaged,
    buildPackagedUiUrl: (path) => `yuri-ui://app${path}`, macosMajorVersion: () => 0, readSettingsRoot: () => ({}),
    MINI_CHAT_WINDOW_WIDTH: 520, MINI_CHAT_WINDOW_HEIGHT: 760, MINI_CHAT_MIN_WINDOW_WIDTH: 360, MINI_CHAT_MIN_WINDOW_HEIGHT: 480,
    getWindowIconPath() {}, app: { isPackaged: packaged, getAppPath: () => '/app' },
    APP_USER_MODEL_ID: 'test.yuri',
    path: { join: (...parts) => parts.join('/') }, isDev: !packaged, __dirname: '/app', nextWindowLabel: () => 'test',
    trackMacWindowVibrancy() {}, buildInitScript: () => '', presentBrowserWindow() {},
    navigateWindow, createAdditionalWindow, emitToWindow: (window, event, detail) => events.push({ window, event, detail }),
  });
  vm.runInContext(source.slice(source.indexOf('const buildMiniChatUrl ='), source.indexOf('const resolveMiniChatRuntimeConfig ='))
    + '\nglobalThis.api = { createMiniChatWindow, setMiniChatPinned, focusAssistantMiniChatTarget };', context);
  return { api: context.api, state, windows, Window, navigateWindow, createAdditionalWindow, events };
};

describe('Assistant Mini Chat native contracts', () => {
  it.each([false, true])('preserves remote authority on cold and warm main-window handoff (packaged=%s)', async (packaged) => {
    const { api, events, createAdditionalWindow } = makeHarness(packaged);
    const mini = await api.createMiniChatWindow({ mode: 'assistant', assistantID: 'a' });
    const target = { hubId: 'hub', hostId: 'remote', instanceId: 'authority' };
    await api.focusAssistantMiniChatTarget(mini, { sessionId: 'same-id', directory: '/same/path', target });
    const primary = await createAdditionalWindow.mock.results[0].value;
    const url = new URL(primary.url);
    expect(url.pathname).toBe('/session/same-id');
    for (const [key, value] of Object.entries(target)) expect(url.searchParams.get(key)).toBe(value);
    expect(url.searchParams.get('directory')).toBe('/same/path');
    await api.focusAssistantMiniChatTarget(mini, { sessionId: 'same-id', directory: '/same/path', target });
    expect(events.at(-1).detail).toEqual({ sessionId: 'same-id', directory: '/same/path', ...target });
    expect(createAdditionalWindow).toHaveBeenCalledOnce();
    await expect(api.focusAssistantMiniChatTarget(mini, { sessionId: 'same-id', directory: '/same/path', target: { hostId: 'remote' } })).rejects.toThrow('Invalid remote');
  });

  it.each([false, true])('opens a dedicated Bot URL and deduplicates without losing pin state (packaged=%s)', async (packaged) => {
    const { api, windows, state } = makeHarness(packaged);
    const options = { mode: 'assistant', assistantID: 'bot / one' };
    const window = await api.createMiniChatWindow(options);
    const url = new URL(window.url);
    expect(url.pathname).toBe('/mini-chat.html');
    expect(url.protocol).toBe(packaged ? 'yuri-ui:' : 'http:');
    expect(url.searchParams.get('mode')).toBe('assistant');
    expect(url.searchParams.get('assistantID')).toBe(options.assistantID);
    expect(url.searchParams.has('sessionId')).toBe(false);
    api.setMiniChatPinned(window, true);
    expect(window.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating');
    expect(await api.createMiniChatWindow(options)).toBe(window);
    expect(window.__yuriPinned).toBe(true);
    expect(window.restore).toHaveBeenCalledOnce();
    await api.createMiniChatWindow({ ...options, runtimeConfig: { apiBaseUrl: 'https://other.example' } });
    await api.createMiniChatWindow({ mode: 'session', sessionId: options.assistantID });
    expect(windows).toHaveLength(3);
    window.destroy();
    expect(state.miniChatWindowsBySession.size).toBe(2);
    expect(await api.createMiniChatWindow(options)).not.toBe(window);
  });

  it('cleans failed navigation and does not leave a dead deduplication entry', async () => {
    const { api, state, navigateWindow, windows } = makeHarness();
    navigateWindow.mockRejectedValueOnce(new Error('load failed'));
    await expect(api.createMiniChatWindow({ mode: 'assistant', assistantID: 'a' })).rejects.toThrow('load failed');
    expect(windows[0].isDestroyed()).toBe(true);
    expect(state.miniChatWindowsBySession.size).toBe(0);
    await expect(api.createMiniChatWindow({ mode: 'assistant', assistantID: 'a' })).resolves.toBeDefined();
  });

  it('an explicitly unauthenticated remote never inherits the local credential', async () => {
    const { api, state } = makeHarness();
    state.clientToken = 'local-test-credential';
    const window = await api.createMiniChatWindow({ mode: 'assistant', assistantID: 'a', runtimeConfig: { apiBaseUrl: 'https://remote.example', clientToken: '' } });
    expect(window.__yuriRuntimeConfig.clientToken).toBe('');
  });

  it('native pin failures preserve the previous state and non-Mini windows cannot be pinned', async () => {
    const { api, Window } = makeHarness();
    expect(() => api.setMiniChatPinned(new Window(), true)).toThrow('only available');
    const window = await api.createMiniChatWindow({ mode: 'assistant', assistantID: 'a' });
    window.setAlwaysOnTop.mockImplementationOnce(() => { throw new Error('native failure'); });
    expect(() => api.setMiniChatPinned(window, true)).toThrow('native failure');
    expect(window.__yuriPinned).toBe(false);
    api.setMiniChatPinned(window, true);
    api.setMiniChatPinned(window, false);
    expect(window.__yuriPinned).toBe(false);
    expect(window.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
  });

  it.each([false, true])('returns to a same-runtime primary or creates the exact route (packaged=%s)', async (packaged) => {
    const { api, Window, events, createAdditionalWindow } = makeHarness(packaged);
    const remote = new Window(); remote.__yuriRuntimeConfig = { apiBaseUrl: 'https://remote.example' };
    const mini = await api.createMiniChatWindow({ mode: 'assistant', assistantID: 'a' });
    await api.focusAssistantMiniChatTarget(mini, { assistantID: 'a' });
    expect(remote.focus).not.toHaveBeenCalled();
    expect(createAdditionalWindow).toHaveBeenCalledOnce();
    const primary = await createAdditionalWindow.mock.results[0].value;
    expect(new URL(primary.url).pathname).toBe('/assistant/a');
    expect(new URL(primary.url).protocol).toBe(packaged ? 'yuri-ui:' : 'http:');
    for (const target of [{ assistantID: 'b' }, { sessionId: 's', directory: '/workspace' }, { projectID: 'p', taskID: 't' }]) {
      await api.focusAssistantMiniChatTarget(mini, target);
      expect(events.at(-1).window).toBe(primary);
      expect(events.at(-1).detail).toEqual(target);
    }
    expect(events.map((event) => event.event)).toEqual(['yuri:open-assistant', 'yuri:open-session', 'yuri:open-scheduled-task']);
    expect(createAdditionalWindow).toHaveBeenCalledOnce();
  });
});
