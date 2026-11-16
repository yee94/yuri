import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createMenuShortcuts, isMenuShortcutSender } from './menu-shortcuts.mjs';
import { createGuiPluginMainHost } from './gui-plugin-host.mjs';
import { createQuitShortcut } from './quit-shortcut.mjs';

function fixture(platform = 'darwin') {
  let time = 0;
  const origins = ['http://localhost:5173'];
  const windows = new Map();
  const Menu = { getApplicationMenu: vi.fn(() => ({ items: [] })), sendActionToFirstResponder: vi.fn() };
  const BrowserWindow = { fromWebContents: contents => windows.get(contents) };
  const host = createMenuShortcuts({
    BrowserWindow, Menu, platform, now: () => time,
    authorize: event => isMenuShortcutSender(event, BrowserWindow, origins),
  });
  const create = (url = 'yuri-ui://app/session/test') => {
    const contents = Object.assign(new EventEmitter(), {
      getURL: () => contents.mainFrame.url, mainFrame: { url }, isDestroyed: vi.fn(() => false),
      setIgnoreMenuShortcuts: vi.fn(), getType: () => 'window',
    });
    const window = {
      webContents: contents, isDestroyed: () => false, isFocused: vi.fn(() => true),
      minimize: vi.fn(), isMinimizable: () => true, setFullScreen: vi.fn(), isFullScreen: () => false,
    };
    windows.set(contents, window);
    const event = { sender: contents, senderFrame: contents.mainFrame };
    const input = (value = {}) => {
      const event = { preventDefault: vi.fn() };
      contents.emit('before-input-event', event, {
        type: 'keyDown', key: 'm', code: 'KeyM', meta: platform === 'darwin', control: platform !== 'darwin',
        alt: false, shift: false, ...value,
      });
      return event;
    };
    return { contents, window, event, input };
  };
  return { host, create, Menu, BrowserWindow, origins, advance: delta => { time += delta; } };
}

describe('window menu shortcut arbitration', () => {
  it('does not parse keys or call native menu APIs without plugin claims, including after release', () => {
    const f = fixture(), a = f.create();
    f.host.track(a.contents);
    const key = vi.fn(() => 'm');
    const type = () => {
      for (let index = 0; index < 50; index++) a.contents.emit('before-input-event', {}, {
        type: 'keyDown', meta: true, get key() { return key(); },
      });
    };
    type();
    expect(key).not.toHaveBeenCalled();
    expect(a.contents.setIgnoreMenuShortcuts).not.toHaveBeenCalled();
    f.host.claim(a.event, ['mod+m']);
    a.input();
    f.host.claim(a.event, []);
    a.contents.setIgnoreMenuShortcuts.mockClear();
    type();
    expect(key).not.toHaveBeenCalled();
    expect(a.contents.setIgnoreMenuShortcuts).not.toHaveBeenCalled();
  });
  it('only ignores a claimed key, restores false on every mismatch and never eats the renderer event', () => {
    const f = fixture(), a = f.create(), b = f.create();
    f.host.claim(a.event, ['mod+m']);
    f.host.claim(b.event, []);
    expect(a.input().preventDefault).not.toHaveBeenCalled();
    expect(a.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
    a.input({ type: 'keyUp' });
    expect(a.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
    b.input();
    expect(b.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    for (const input of [{ key: 'c' }, { key: 'Meta', type: 'keyUp' }, { shift: true }, { alt: true }, { control: true }, { isComposing: true }]) {
      a.input(input);
      expect(a.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    }
    a.input();
    f.host.claim(a.event, []);
    expect(a.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    a.input();
    expect(a.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
  });

  it.each(['darwin', 'win32', 'linux'])('matches shared UI modifier, punctuation and Option semantics on %s', platform => {
    const f = fixture(platform), a = f.create();
    f.host.claim(a.event, ['mod+m', 'ctrl+backtick', 'mod+alt+x', 'mod+shift+[', 'mod+comma', 'mod+minus', 'mod+shift+plus']);
    for (const input of [
      {}, { key: 'Dead', code: 'Backquote', meta: false, control: true },
      { key: '≈', code: 'KeyX', alt: true },
      { key: '{', code: 'BracketLeft', shift: true }, { key: ',' }, { key: '-' }, { key: '+', shift: true },
    ]) {
      a.input(input);
      expect(a.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
    }
    a.input(platform === 'darwin' ? { meta: false, control: true } : { meta: true });
    expect(a.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
  });

  it('preserves the macOS Cmd+Q guard, including the physical Q key on another layout', () => {
    const f = fixture(), a = f.create();
    const quit = vi.fn();
    const guard = createQuitShortcut({ quit, showHint: vi.fn(), hideHint: vi.fn() });
    a.contents.on('before-input-event', (event, input) => guard.handleInput(event, input, a.contents));
    f.host.claim(a.event, ['mod+q', 'mod+x']);
    const first = a.input({ key: 'q', code: 'KeyQ' });
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(a.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    a.input({ key: 'q', code: 'KeyQ', type: 'keyUp' });
    a.input({ key: 'x', code: 'KeyQ' });
    expect(a.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    expect(quit).toHaveBeenCalledOnce();
    guard.cancel();
  });

  it('releases claims on main navigation/crash/destruction, not subframe or SPA navigation', () => {
    const f = fixture(), a = f.create();
    f.host.claim(a.event, ['mod+m']);
    a.contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    a.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    a.input();
    expect(a.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
    a.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(() => f.host.claim(a.event, ['mod+m'])).toThrow('navigating');
    a.input();
    expect(a.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    a.contents.emit('did-navigate');
    f.host.claim(a.event, ['mod+m']);
    a.contents.emit('render-process-gone');
    a.input();
    expect(a.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    a.contents.emit('did-navigate');
    f.host.claim(a.event, ['mod+m']);
    a.contents.emit('destroyed');
    for (const event of ['before-input-event', 'blur', 'did-start-navigation', 'did-navigate', 'render-process-gone', 'destroyed']) {
      expect(a.contents.listenerCount(event)).toBe(0);
    }
  });

  it('bounds claims and rejects malformed input atomically', () => {
    const f = fixture(), a = f.create();
    f.host.claim(a.event, ['mod+m']);
    for (const combos of [null, 'mod+m', [null], ['meta+m'], ['mod+'], ['x'.repeat(129)], Array(4097).fill('mod+m')]) {
      expect(() => f.host.claim(a.event, combos)).toThrow('Invalid menu shortcut');
    }
    a.input();
    expect(a.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
  });

  it('tracks navigation before the first claim, preventing old-document IPC from reviving claims', () => {
    const f = fixture(), a = f.create();
    f.host.track(a.contents);
    a.contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(() => f.host.claim(a.event, ['mod+m'])).toThrow('navigating');
    a.contents.emit('did-navigate');
    f.host.claim(a.event, ['mod+m']);
    a.input();
    expect(a.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
  });

  it('compiles at claim time with one listener and constant event work for 4096 bindings', () => {
    const f = fixture(), a = f.create();
    const combos = Array.from({ length: 4095 }, (_, index) => `mod+key${index}`);
    combos.push('mod+m');
    f.host.claim(a.event, combos);
    f.host.claim(a.event, combos);
    expect(a.contents.listenerCount('before-input-event')).toBe(1);
    const reading = vi.fn(() => 'm');
    for (let i = 0; i < 100; i++) a.contents.emit('before-input-event', { preventDefault: vi.fn() }, {
      type: 'keyDown', meta: true, code: 'KeyM', get key() { return reading(); },
    });
    expect(reading.mock.calls.length).toBeLessThanOrEqual(200);
    expect(a.contents.setIgnoreMenuShortcuts.mock.calls.filter(([ignore]) => ignore)).toHaveLength(100);
  });
});

describe('one-shot native fallback after renderer declines a command', () => {
  it('minimizes only on explicit fallback, once, without injecting another renderer key', () => {
    const f = fixture(), a = f.create(), b = f.create();
    f.Menu.getApplicationMenu.mockReturnValue({ items: [{ submenu: { items: [{ role: 'minimize', accelerator: 'CommandOrControl+M' }] } }] });
    f.host.claim(a.event, ['mod+m']);
    f.host.claim(b.event, ['mod+m']);
    a.input();
    expect(a.window.minimize).not.toHaveBeenCalled();
    expect(f.host.fallback(b.event, 'mod+m')).toBe(false);
    expect(f.host.fallback(a.event, 'mod+m')).toBe(true);
    expect(a.window.minimize).toHaveBeenCalledOnce();
    expect(f.host.fallback(a.event, 'mod+m')).toBe(false);
    expect(a.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
  });

  it.each(['timeout', 'blur', 'claims', 'mismatch', 'unfocused', 'other-key', 'navigation', 'crash'])('invalidates fallback on %s', reason => {
    const f = fixture(), a = f.create();
    const click = vi.fn();
    f.Menu.getApplicationMenu.mockReturnValue({ items: [{ accelerator: 'Cmd+M', click }] });
    f.host.claim(a.event, ['mod+m']);
    a.input();
    if (reason === 'timeout') f.advance(1000);
    if (reason === 'blur') a.contents.emit('blur');
    if (reason === 'claims') f.host.claim(a.event, ['mod+m']);
    if (reason === 'unfocused') a.window.isFocused.mockReturnValue(false);
    if (reason === 'other-key') a.input({ key: 'c' });
    if (reason === 'navigation') a.contents.emit('did-start-navigation', { isMainFrame: true });
    if (reason === 'crash') a.contents.emit('render-process-gone');
    expect(f.host.fallback(a.event, reason === 'mismatch' ? 'mod+c' : 'mod+m')).toBe(false);
    expect(click).not.toHaveBeenCalled();
    expect(f.host.fallback(a.event, 'mod+m')).toBe(false);
  });

  it('reuses menu click callbacks and respects enabled/registered accelerators', () => {
    const f = fixture(), a = f.create();
    const click = vi.fn();
    f.Menu.getApplicationMenu.mockReturnValue({ items: [
      { accelerator: 'Cmd+M', enabled: false, click: vi.fn() },
      { accelerator: 'Cmd+M', registerAccelerator: false, click: vi.fn() },
      { accelerator: 'Cmd+M', click },
    ] });
    f.host.claim(a.event, ['mod+m']);
    a.input();
    expect(f.host.fallback(a.event, 'mod+m')).toBe(true);
    expect(click).toHaveBeenCalledExactlyOnceWith({ triggeredByAccelerator: true }, a.window, a.contents);
    f.Menu.getApplicationMenu.mockReturnValue({ items: [] });
    a.input();
    expect(f.host.fallback(a.event, 'mod+m')).toBe(false);
  });

  it('replays existing Cocoa edit roles, never the quit role', () => {
    const f = fixture(), a = f.create();
    f.Menu.getApplicationMenu.mockReturnValue({ items: [{ role: 'paste', accelerator: 'Command+V', registerAccelerator: false }] });
    f.host.claim(a.event, ['mod+v', 'mod+q']);
    a.input({ key: 'v', code: 'KeyV' });
    expect(f.host.fallback(a.event, 'mod+v')).toBe(true);
    expect(f.Menu.sendActionToFirstResponder).toHaveBeenCalledExactlyOnceWith('paste:');
    a.input({ key: 'q', code: 'KeyQ' });
    expect(f.host.fallback(a.event, 'mod+q')).toBe(false);
  });

  it.each(['win32', 'linux'])('replays the current registered menu action on %s with Electron key aliases', platform => {
    const f = fixture(platform), a = f.create();
    const click = vi.fn();
    f.Menu.getApplicationMenu.mockReturnValue({ items: [{ accelerator: 'Ctrl+Alt+Up', click }] });
    f.host.claim(a.event, ['ctrl+alt+arrowup']);
    a.input({ key: 'ArrowUp', code: 'ArrowUp', alt: true });
    expect(f.host.fallback(a.event, 'ctrl+alt+arrowup')).toBe(true);
    expect(click).toHaveBeenCalledExactlyOnceWith({ triggeredByAccelerator: true }, a.window, a.contents);
  });
});

describe('main-process capability admission', () => {
  it('retains menu arbitration after real window-only restriction without restoring native plugin privileges', async () => {
    const f = fixture(), a = f.create();
    const plugins = createGuiPluginMainHost({
      app: new EventEmitter(), windows: f.BrowserWindow,
      getClient: () => { throw new Error('Native plugin execution must stay unavailable'); },
      authorizeWindow: event => isMenuShortcutSender(event, f.BrowserWindow, f.origins),
      authorize: () => true, send: vi.fn(), report: vi.fn(),
    });
    try {
      await plugins.handle(a.event, 'window-only');
      expect(plugins.isWindowOnly(a.contents)).toBe(true);
      f.host.claim(a.event, ['mod+m']);
      a.input();
      expect(a.contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
      await expect(plugins.handle(a.event, 'acquire', { id: 'test', revision: 'r1' }))
        .rejects.toMatchObject({ code: 'GUI_PLUGIN_DOCUMENT_RESTRICTED' });
    } finally { await plugins.dispose(); }
  });

  it('admits local/window-only and saved remote app documents, not arbitrary remote or preview/subframes', () => {
    const source = readFileSync(fileURLToPath(new URL('./main.mjs', import.meta.url)), 'utf8');
    const registration = source.slice(source.indexOf('const menuShortcuts ='), source.indexOf('const viewExportHost ='));
    const f = fixture(), local = f.create(), remote = f.create('https://saved.invalid/session/test');
    remote.window.__yuriHostId = 'saved';
    remote.window.__yuriRuntimeConfig = { apiBaseUrl: 'https://saved.invalid' };
    const handlers = new Map();
    new Function('createMenuShortcuts', 'isMenuShortcutSender', 'BrowserWindow', 'Menu', 'readDesktopHostsConfig', 'state', 'ipcMain', 'app', registration)(
      createMenuShortcuts, isMenuShortcutSender, f.BrowserWindow, f.Menu,
      () => ({ hosts: [{ id: 'saved' }] }), { localUiOrigin: 'http://localhost:5173' },
      { handle: (channel, handler) => handlers.set(channel, handler) }, new EventEmitter());
    const claim = handlers.get('yuri:menu-shortcuts:claim');
    expect(() => claim(local.event, ['mod+m'])).not.toThrow();
    expect(() => claim(remote.event, ['mod+m'])).not.toThrow();
    expect(() => claim({ ...local.event, senderFrame: { url: local.contents.getURL() } }, [])).toThrow('trusted main');
    for (const url of ['yuri-ui://app/preview.html', 'http://localhost:5173/api/fs/raw', 'https://foreign.invalid/', 'https://saved.invalid/api/preview/test']) {
      const denied = f.create(url);
      denied.window.__yuriHostId = 'saved';
      denied.window.__yuriRuntimeConfig = remote.window.__yuriRuntimeConfig;
      expect(() => claim(denied.event, [])).toThrow('trusted main');
    }
    remote.window.__yuriHostId = 'not-saved';
    expect(() => claim(remote.event, [])).toThrow('trusted main');
    local.contents.mainFrame = { url: 'yuri-ui://app/session/new' };
    expect(() => claim(local.event, [])).toThrow('trusted main');
  });

  it('preload exposes only the two narrow methods to the main frame', async () => {
    const source = readFileSync(fileURLToPath(new URL('./preload.mjs', import.meta.url)), 'utf8');
    const bridge = source.slice(source.indexOf('  menuShortcuts:'), source.indexOf('  guiPlugins:'));
    const invoke = vi.fn(async () => undefined);
    const make = isMainFrame => new Function('process', 'ipcRenderer', `return {${bridge}}`)({ isMainFrame }, { invoke }).menuShortcuts;
    expect(make(false)).toBeUndefined();
    const api = make(true);
    expect(Object.keys(api)).toEqual(['claim', 'fallback']);
    await api.claim(['mod+m']);
    await api.fallback('mod+m');
    expect(invoke.mock.calls).toEqual([
      ['yuri:menu-shortcuts:claim', ['mod+m']], ['yuri:menu-shortcuts:fallback', 'mod+m'],
    ]);
  });

  it('rejects preview guests, destroyed/unowned contents, and credential-bearing app URLs', () => {
    const f = fixture(), a = f.create();
    a.window.webContents = {};
    expect(isMenuShortcutSender(a.event, f.BrowserWindow, f.origins)).toBe(false);
    const b = f.create();
    b.contents.isDestroyed.mockReturnValue(true);
    expect(isMenuShortcutSender(b.event, f.BrowserWindow, f.origins)).toBe(false);
    expect(isMenuShortcutSender(b.event, { fromWebContents: () => null }, f.origins)).toBe(false);
    const c = f.create('http://user:password@localhost:5173/session/test');
    expect(isMenuShortcutSender(c.event, f.BrowserWindow, f.origins)).toBe(false);
  });
});
