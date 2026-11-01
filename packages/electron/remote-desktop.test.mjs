import { beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRemoteDesktopAdapter as createAdapter } from './remote-desktop.mjs';

const mock = vi.hoisted(() => ({
  consent: vi.fn(), accessibility: vi.fn(), sources: vi.fn(), windows: [], spawn: vi.fn(),
  ipc: null, screens: null, partition: null, exists: vi.fn(), exec: vi.fn(), media: vi.fn(), open: vi.fn(),
}));
vi.mock('node:fs', () => ({ default: { existsSync: mock.exists } }));
vi.mock('node:child_process', () => ({ spawn: mock.spawn, execFile: mock.exec }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  mock.ipc = new EventEmitter(); mock.screens = new EventEmitter();
  mock.screens.getPrimaryDisplay = () => ({ id: 123, workArea: { x: 0, y: 0, width: 1600, height: 900 } });
  mock.partition = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() };
  class Window extends EventEmitter {
    destroyed = false;
    constructor(options) {
      super(); this.options = options; this.webContents = new EventEmitter();
      this.webContents.mainFrame = {};
      this.webContents.setWindowOpenHandler = vi.fn(); this.webContents.send = vi.fn();
      mock.windows.push(this);
    }
    async loadURL() {}
    showInactive() {}
    async loadFile() {
      const event = { sender: this.webContents, senderFrame: this.webContents.mainFrame };
      mock.ipc.emit('yuri:capture:loaded', event);
      mock.ipc.emit('yuri:capture:message', event, { type: 'ready', width: 1600, height: 900 });
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  return {
    app: { isPackaged: false, getAppPath: () => '/fixture/app' }, BrowserWindow: Window,
    desktopCapturer: { getSources: mock.sources }, dialog: { showMessageBox: mock.consent }, ipcMain: mock.ipc,
    screen: mock.screens, session: { fromPartition: () => mock.partition },
    systemPreferences: { isTrustedAccessibilityClient: mock.accessibility, getMediaAccessStatus: mock.media },
    shell: { openExternal: mock.open },
  };
});
beforeEach(() => {
  mock.windows.length = 0; mock.ipc.removeAllListeners(); mock.screens.removeAllListeners();
  mock.consent.mockReset().mockResolvedValue({ response: 1 });
  mock.accessibility.mockReset().mockReturnValue(true);
  mock.exists.mockReset().mockReturnValue(true);
  mock.media.mockReset().mockReturnValue('granted');
  mock.exec.mockReset().mockImplementation((_file, _args, _options, callback) => callback(null, 'granted\n', ''));
  mock.open.mockReset().mockResolvedValue();
  mock.sources.mockReset().mockResolvedValue([{ id: 'screen:primary', display_id: '123' }]);
  mock.spawn.mockReset().mockImplementation(() => {
    const child = new EventEmitter(); child.stdin = new EventEmitter(); child.stdout = new EventEmitter();
    child.stdin.write = vi.fn(); child.stdin.end = vi.fn(); child.stdin.writableLength = 0;
    child.exitCode = 0; child.kill = vi.fn();
    return child;
  });
});
const nativeTest = process.platform === 'darwin' ? it : it.skip;
const storeFor = (root = { enabled: true }) => ({
  readRoot: () => structuredClone(root),
  mutate: vi.fn(async mutator => { const next = structuredClone(root); await mutator(next); Object.assign(root, next); }),
});
const createRemoteDesktopAdapter = (options = {}) => createAdapter({ approvalsStore: storeFor(), ...options });

nativeTest('defaults off even for previously trusted devices, refuses capture and preserves approval data when enabled', async () => {
  const root = { clients: ['phone-a'] };
  const adapter = createAdapter({ approvalsStore: storeFor(root) });
  expect(adapter.enabled).toBe(false);
  await expect(adapter.start({ send: vi.fn(), onEnded: vi.fn() })).rejects.toMatchObject({ code: 'disabled' });
  expect(mock.consent).not.toHaveBeenCalled(); expect(mock.spawn).not.toHaveBeenCalled();
  await adapter.setEnabled(true);
  expect(root).toEqual({ clients: ['phone-a'], enabled: true });
  expect(adapter.enabled).toBe(true);
});

nativeTest('checks both app and input-helper authorization before enabling and exposes permission guidance without enabling', async () => {
  const root = {};
  const adapter = createAdapter({ approvalsStore: storeFor(root) });
  mock.exec.mockImplementation((_file, _args, _options, callback) => callback(null, 'denied\n', ''));
  expect((await adapter.getStatus()).ready).toBe(false);
  await expect(adapter.setEnabled(true)).rejects.toMatchObject({ code: 'permission_required' });
  await adapter.requestPermission('accessibility');
  expect(mock.exec.mock.calls.some(call => call[1][0] === '--request-accessibility')).toBe(true);
  expect(mock.open).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  await expect(adapter.requestPermission('arbitrary-url')).rejects.toMatchObject({ code: 'invalid_permission' });
  expect(root).toEqual({});
});

nativeTest('disabling immediately ends active capture and stays blocked if persistence fails', async () => {
  const store = storeFor();
  const adapter = createAdapter({ approvalsStore: store });
  const ended = vi.fn();
  await adapter.start({ send: vi.fn(), onEnded: ended });
  store.mutate.mockRejectedValue(new Error('disk failure'));
  await expect(adapter.setEnabled(false)).rejects.toThrow('disk failure');
  expect(ended).toHaveBeenCalledOnce();
  expect(mock.windows.every(win => win.destroyed)).toBe(true);
  expect(adapter.enabled).toBe(false);
  await expect(adapter.start({ send: vi.fn(), onEnded: vi.fn() })).rejects.toMatchObject({ code: 'disabled' });
});

nativeTest('enable persistence failure never enables control and screen guidance does not enable it either', async () => {
  const store = storeFor({});
  store.mutate.mockRejectedValue(new Error('disk failure'));
  const adapter = createAdapter({ approvalsStore: store });
  await expect(adapter.setEnabled(true)).rejects.toThrow('disk failure');
  expect(adapter.enabled).toBe(false);
  mock.media.mockReturnValue('not-determined');
  await adapter.requestPermission('screen');
  expect(mock.sources).toHaveBeenCalledWith({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
  expect(adapter.enabled).toBe(false);
});

nativeTest('turning off cancels pending screen discovery and late completion cannot start capture', async () => {
  let sources;
  mock.sources.mockImplementation(() => new Promise(resolve => { sources = resolve; }));
  const adapter = createRemoteDesktopAdapter();
  const ended = vi.fn();
  const pending = adapter.start({ send: vi.fn(), onEnded: ended });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'permission_denied' });
  await vi.waitFor(() => expect(sources).toBeDefined());
  await adapter.setEnabled(false);
  sources([{ id: 'screen:primary', display_id: '123' }]);
  await rejected;
  expect(ended).toHaveBeenCalledOnce(); expect(mock.windows).toHaveLength(0);
  expect(mock.spawn).not.toHaveBeenCalled();
});
nativeTest('missing app accessibility permission never prompts or starts capture or native input', async () => {
  mock.accessibility.mockReturnValue(false);
  await expect(createRemoteDesktopAdapter().start({ send: vi.fn(), onEnded: vi.fn(), signal: new AbortController().signal })).rejects.toMatchObject({ code: 'permission_required' });
  expect(mock.sources).not.toHaveBeenCalled(); expect(mock.spawn).not.toHaveBeenCalled();
  expect(mock.accessibility).toHaveBeenCalledWith(false);
  expect(mock.accessibility).not.toHaveBeenCalledWith(true);
  expect(mock.consent).not.toHaveBeenCalled();
});
nativeTest('never falls back to a different screen if primary-display identity does not match', async () => {
  mock.sources.mockResolvedValue([{ id: 'screen:other', display_id: '999' }]);
  await expect(createRemoteDesktopAdapter().start({ send: vi.fn(), onEnded: vi.fn(), signal: new AbortController().signal })).rejects.toMatchObject({ code: 'permission_required' });
  expect(mock.spawn).not.toHaveBeenCalled(); expect(mock.windows.every(win => win.destroyed)).toBe(true);
});
nativeTest('only the owned capture frame can publish media; stop closes all resources and releases input', async () => {
  const send = vi.fn(() => true), ended = vi.fn();
  const adapter = createRemoteDesktopAdapter();
  const desktop = await adapter.start({ send, onEnded: ended, signal: new AbortController().signal });
  const capture = mock.windows.at(-1);
  expect(capture.options.webPreferences).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false });
  expect(mock.spawn.mock.calls[0][1]).toEqual(['123']);
  const child = mock.spawn.mock.results[0].value; child.stdout.emit('data', Buffer.from('ready\n'));
  const owned = { sender: capture.webContents, senderFrame: capture.webContents.mainFrame };
  const untrusted = { sender: new EventEmitter(), senderFrame: {} };
  send.mockClear();
  mock.ipc.emit('yuri:capture:frame', untrusted, new ArrayBuffer(10));
  mock.ipc.emit('yuri:capture:frame', { ...owned, senderFrame: {} }, new ArrayBuffer(10));
  expect(send).not.toHaveBeenCalled();
  mock.ipc.emit('yuri:capture:frame', owned, new ArrayBuffer(10));
  expect(send).toHaveBeenCalledTimes(1);
  await desktop.handle({ type: 'pointer', action: 'down', x: 0.5, y: 0.5 });
  expect(child.stdin.write).toHaveBeenCalledWith('{"type":"pointer","action":"down","x":0.5,"y":0.5}\n');
  desktop.close(); desktop.close(); adapter.stop();
  expect(child.stdin.end).toHaveBeenCalledTimes(1);
  expect(mock.windows.every(win => win.destroyed)).toBe(true);
  expect(mock.ipc.listenerCount('yuri:capture:frame')).toBe(0);
  expect(ended).not.toHaveBeenCalled();
});

nativeTest('enabled and authorized devices connect directly without a dialog, visible status window or approval writes', async () => {
  const stored = { enabled: true, clients: ['phone-a'] };
  const store = { readRoot: () => structuredClone(stored), mutate: vi.fn(async mutator => { const next = structuredClone(stored); await mutator(next); Object.assign(stored, next); }) };
  const adapter = createRemoteDesktopAdapter({ approvalsStore: store });
  const first = await adapter.start({ send: vi.fn(() => true), onEnded: vi.fn(), signal: new AbortController().signal, client: { id: 'phone-a', label: 'Phone A' } });
  first.close();
  const second = await adapter.start({ send: vi.fn(() => true), onEnded: vi.fn(), signal: new AbortController().signal, client: { id: 'phone-b', label: 'Phone B' } });
  expect(mock.consent).not.toHaveBeenCalled();
  expect(store.mutate).not.toHaveBeenCalled();
  expect(stored.clients).toEqual(['phone-a']);
  expect(mock.windows).toHaveLength(2);
  expect(mock.windows.every(win => win.options.show === false && !win.options.alwaysOnTop)).toBe(true);
  expect(mock.ipc.listenerCount('yuri:capture:stop')).toBe(0);
  expect(mock.ipc.listenerCount('yuri:capture:forget')).toBe(0);
  second.close();
});

nativeTest('revoked screen or helper permissions fail closed without opening authorization dialogs', async () => {
  const adapter = createRemoteDesktopAdapter();
  mock.media.mockReturnValue('denied');
  await expect(adapter.start({ send: vi.fn(), onEnded: vi.fn() })).rejects.toMatchObject({ code: 'permission_required' });
  mock.media.mockReturnValue('granted');
  mock.exec.mockImplementation((_file, _args, _options, callback) => callback(null, 'denied\n', ''));
  await expect(adapter.start({ send: vi.fn(), onEnded: vi.fn() })).rejects.toMatchObject({ code: 'permission_required' });
  expect(mock.sources).not.toHaveBeenCalled(); expect(mock.spawn).not.toHaveBeenCalled();
  expect(mock.windows).toHaveLength(0); expect(mock.consent).not.toHaveBeenCalled();
  expect(mock.exec.mock.calls.every(call => call[1][0] === '--check-accessibility')).toBe(true);
});

nativeTest('disconnect during permission checking never starts capture after the check completes', async () => {
  let permissions;
  mock.exec.mockImplementation((_file, _args, _options, callback) => { permissions = callback; });
  const signal = new AbortController();
  const pending = createRemoteDesktopAdapter().start({ send: vi.fn(), onEnded: vi.fn(), signal: signal.signal });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'permission_denied' });
  signal.abort(); permissions(null, 'granted\n');
  await rejected;
  expect(mock.windows).toHaveLength(0); expect(mock.spawn).not.toHaveBeenCalled();
});
