import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRemoteDesktopAdapter as createAdapter } from './remote-desktop.mjs';

const mock = vi.hoisted(() => ({
  consent: vi.fn(), accessibility: vi.fn(), sources: vi.fn(), windows: [], spawn: vi.fn(),
  ipc: null, screens: null, power: null, partition: null, exists: vi.fn(), exec: vi.fn(), media: vi.fn(), open: vi.fn(), load: vi.fn(), helperAutoReady: true,
  blocker: { start: vi.fn(), stop: vi.fn() },
}));
vi.mock('node:fs', () => ({ default: { existsSync: mock.exists } }));
vi.mock('node:child_process', () => ({ spawn: mock.spawn, execFile: mock.exec }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  mock.ipc = new EventEmitter(); mock.screens = new EventEmitter(); mock.power = new EventEmitter();
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
      await mock.load();
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
    screen: mock.screens, powerMonitor: mock.power, powerSaveBlocker: mock.blocker, session: { fromPartition: () => mock.partition },
    systemPreferences: { isTrustedAccessibilityClient: mock.accessibility, getMediaAccessStatus: mock.media },
    shell: { openExternal: mock.open },
  };
});
beforeEach(() => {
  mock.windows.length = 0; mock.ipc.removeAllListeners(); mock.screens.removeAllListeners(); mock.power.removeAllListeners();
  mock.consent.mockReset().mockResolvedValue({ response: 1 });
  mock.accessibility.mockReset().mockReturnValue(true);
  mock.exists.mockReset().mockReturnValue(true);
  mock.media.mockReset().mockReturnValue('granted');
  mock.exec.mockReset().mockImplementation((_file, _args, _options, callback) => callback(null, 'granted\n', ''));
  mock.open.mockReset().mockResolvedValue();
  mock.load.mockReset().mockResolvedValue();
  mock.helperAutoReady = true;
  mock.blocker.start.mockReset().mockReturnValue(0);
  mock.blocker.stop.mockReset();
  mock.sources.mockReset().mockResolvedValue([{ id: 'screen:primary', display_id: '123' }]);
  mock.spawn.mockReset().mockImplementation(() => {
    const child = new EventEmitter(); child.stdin = new EventEmitter(); child.stdout = new EventEmitter();
    child.stdin.write = vi.fn(); child.stdin.end = vi.fn(); child.stdin.writableLength = 0;
    child.exitCode = 0; child.kill = vi.fn();
    if (mock.helperAutoReady) queueMicrotask(() => child.stdout.emit('data', Buffer.from('ready\n')));
    return child;
  });
});
afterEach(() => { vi.useRealTimers(); });
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
  await expect(createRemoteDesktopAdapter().start({ send: vi.fn(), onEnded: vi.fn(), signal: new AbortController().signal })).rejects.toMatchObject({ code: 'display_unavailable' });
  expect(mock.spawn).not.toHaveBeenCalled(); expect(mock.windows.every(win => win.destroyed)).toBe(true);
});

nativeTest('wakes a sleeping display after authorization and keeps it awake only for the capture lifetime', async () => {
  let awake = false;
  mock.sources.mockImplementation(async () => awake ? [{ id: 'screen:primary', display_id: '123' }] : []);
  mock.exec.mockImplementation((file, _args, _options, done) => {
    if (file === '/usr/bin/caffeinate') { awake = true; done(null, '', ''); }
    else done(null, 'granted\n', '');
  });
  const desktop = await createRemoteDesktopAdapter().start({ send: vi.fn(), onEnded: vi.fn() });
  expect(mock.exec).toHaveBeenCalledWith('/usr/bin/caffeinate', ['-u', '-t', '1'],
    expect.objectContaining({ timeout: 3000, windowsHide: true, signal: expect.any(AbortSignal) }), expect.any(Function));
  expect(mock.sources).toHaveBeenCalledTimes(2);
  expect(mock.blocker.start).toHaveBeenCalledWith('prevent-display-sleep');
  expect(mock.blocker.stop).not.toHaveBeenCalled();
  expect(mock.spawn.mock.calls[0][1]).toEqual(['123']);
  expect(mock.spawn.mock.results[0].value.stdin.write).not.toHaveBeenCalled();
  desktop.close(); desktop.close();
  expect(mock.blocker.stop).toHaveBeenCalledExactlyOnceWith(0);
});

nativeTest('waits for display enumeration to recover after waking without failing the connection', async () => {
  vi.useFakeTimers();
  mock.sources.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  const pending = createRemoteDesktopAdapter().start({ send: vi.fn(), onEnded: vi.fn() });
  await vi.advanceTimersByTimeAsync(500);
  const desktop = await pending;
  expect(mock.exec.mock.calls.filter(([file]) => file === '/usr/bin/caffeinate')).toHaveLength(1);
  expect(mock.sources).toHaveBeenCalledTimes(4);
  desktop.close();
  expect(mock.blocker.stop).toHaveBeenCalledExactlyOnceWith(0);
});

nativeTest('does not wake or change the target when enumerated sources belong to another display', async () => {
  mock.sources.mockResolvedValue([{ id: 'screen:other', display_id: '999' }]);
  await expect(createRemoteDesktopAdapter().start({ send: vi.fn(), onEnded: vi.fn() })).rejects.toMatchObject({ code: 'display_unavailable' });
  expect(mock.exec.mock.calls.some(([file]) => file === '/usr/bin/caffeinate')).toBe(false);
  expect(mock.blocker.stop).toHaveBeenCalledExactlyOnceWith(0);
});

nativeTest('bounds empty screen recovery and releases display power on failure', async () => {
  vi.useFakeTimers();
  mock.sources.mockResolvedValue([]);
  const pending = expect(createRemoteDesktopAdapter().start({ send: vi.fn(), onEnded: vi.fn() }))
    .rejects.toMatchObject({ code: 'display_unavailable' });
  await vi.advanceTimersByTimeAsync(4000);
  await pending;
  expect(mock.exec.mock.calls.filter(([file]) => file === '/usr/bin/caffeinate')).toHaveLength(1);
  expect(mock.sources.mock.calls.length).toBeLessThanOrEqual(10);
  expect(mock.spawn).not.toHaveBeenCalled();
  expect(mock.blocker.stop).toHaveBeenCalledExactlyOnceWith(0);
  expect(vi.getTimerCount()).toBe(0);
});

nativeTest('a failed display wake releases power and stays retryable without requesting permission', async () => {
  mock.sources.mockResolvedValue([]);
  mock.exec.mockImplementation((file, _args, _options, done) => {
    if (file === '/usr/bin/caffeinate') done(new Error('wake failed'));
    else done(null, 'granted\n', '');
  });
  await expect(createRemoteDesktopAdapter().start({ send: vi.fn(), onEnded: vi.fn() }))
    .rejects.toMatchObject({ code: 'display_unavailable' });
  expect(mock.sources).toHaveBeenCalledTimes(1);
  expect(mock.blocker.stop).toHaveBeenCalledExactlyOnceWith(0);
  expect(mock.spawn).not.toHaveBeenCalled();
  expect(mock.open).not.toHaveBeenCalled();
});

nativeTest('cancels display rediscovery and its power assertion when disabled during wake recovery', async () => {
  vi.useFakeTimers();
  mock.sources.mockResolvedValue([]);
  const adapter = createRemoteDesktopAdapter();
  const pending = expect(adapter.start({ send: vi.fn(), onEnded: vi.fn() }))
    .rejects.toMatchObject({ code: 'permission_denied' });
  await vi.advanceTimersByTimeAsync(0);
  expect(mock.sources).toHaveBeenCalledTimes(2);
  await adapter.setEnabled(false);
  await pending;
  await vi.advanceTimersByTimeAsync(3000);
  expect(mock.sources).toHaveBeenCalledTimes(2);
  expect(mock.blocker.stop).toHaveBeenCalledExactlyOnceWith(0);
  expect(mock.spawn).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

nativeTest('aborting display wake cancels its process and cannot affect the next capture', async () => {
  mock.sources.mockResolvedValueOnce([]);
  let wakeOptions, finishWake;
  mock.exec.mockImplementation((file, _args, options, done) => {
    if (file === '/usr/bin/caffeinate') { wakeOptions = options; finishWake = done; }
    else done(null, 'granted\n', '');
  });
  const adapter = createRemoteDesktopAdapter();
  const controller = new AbortController();
  const pending = adapter.start({ send: vi.fn(), onEnded: vi.fn(), signal: controller.signal });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'permission_denied' });
  await vi.waitFor(() => expect(wakeOptions).toBeDefined());
  controller.abort();
  await rejected;
  expect(wakeOptions.signal.aborted).toBe(true);
  expect(mock.blocker.stop).toHaveBeenCalledTimes(1);
  const next = await adapter.start({ send: vi.fn(), onEnded: vi.fn() });
  finishWake(null, '', '');
  await Promise.resolve();
  expect(mock.windows).toHaveLength(1);
  expect(mock.windows[0].destroyed).toBe(false);
  expect(mock.blocker.stop).toHaveBeenCalledTimes(1);
  next.close();
});

nativeTest('bounds hung screen discovery, frees startup on abort, and ignores its late completion', async () => {
  vi.useFakeTimers();
  let finish;
  mock.sources.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const adapter = createRemoteDesktopAdapter();
  const first = adapter.start({ send: vi.fn(), onEnded: vi.fn() });
  const rejected = expect(first).rejects.toMatchObject({ code: 'capture_timeout' });
  await vi.advanceTimersByTimeAsync(15000);
  await rejected;
  const next = await adapter.start({ send: vi.fn(), onEnded: vi.fn() });
  finish([{ id: 'screen:primary', display_id: '123' }]);
  await vi.advanceTimersByTimeAsync(0);
  expect(mock.windows).toHaveLength(1);
  expect(mock.windows[0].destroyed).toBe(false);
  next.close();
  expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
});

nativeTest('capture timeout with granted permissions is retryable and the next capture succeeds', async () => {
  vi.useFakeTimers();
  mock.load.mockImplementationOnce(() => new Promise(() => {}));
  const adapter = createRemoteDesktopAdapter();
  const ended = vi.fn();
  const failed = expect(adapter.start({ send: vi.fn(), onEnded: ended })).rejects.toMatchObject({ code: 'capture_timeout' });
  await vi.advanceTimersByTimeAsync(15000);
  await failed;
  expect(mock.windows[0].destroyed).toBe(true);
  expect(ended).not.toHaveBeenCalled();
  const next = await adapter.start({ send: vi.fn(), onEnded: ended });
  expect(mock.windows).toHaveLength(2);
  next.close();
});

nativeTest('helper execution failure remains retryable rather than becoming a denied grant', async () => {
  const adapter = createRemoteDesktopAdapter();
  mock.exec.mockImplementationOnce((_file, _args, _options, done) => done(new Error('timeout'), ''));
  await expect(adapter.start({ send: vi.fn(), onEnded: vi.fn() })).rejects.toMatchObject({ code: 'helper_check_failed' });
  const next = await adapter.start({ send: vi.fn(), onEnded: vi.fn() });
  next.close();
});

nativeTest('a renderer startup failure preserves its retryable cause and releases capture before reconnect', async () => {
  mock.load.mockImplementationOnce(async () => {
    const win = mock.windows.at(-1);
    mock.ipc.emit('yuri:capture:message', { sender: win.webContents, senderFrame: win.webContents.mainFrame }, { type: 'failure' });
  });
  const adapter = createRemoteDesktopAdapter();
  const ended = vi.fn();
  await expect(adapter.start({ send: vi.fn(), onEnded: ended })).rejects.toMatchObject({ code: 'capture_failed' });
  expect(ended).not.toHaveBeenCalled();
  expect(mock.windows[0].destroyed).toBe(true);
  const next = await adapter.start({ send: vi.fn(), onEnded: ended });
  next.close();
});

nativeTest('abort releases a hung discovery immediately, without waiting for source enumeration', async () => {
  mock.sources.mockImplementation(() => new Promise(() => {}));
  const controller = new AbortController();
  const pending = createRemoteDesktopAdapter().start({ send: vi.fn(), onEnded: vi.fn(), signal: controller.signal });
  const failed = expect(pending).rejects.toMatchObject({ code: 'permission_denied' });
  await vi.waitFor(() => expect(mock.sources).toHaveBeenCalled());
  controller.abort();
  await failed;
  expect(mock.windows).toHaveLength(0);
});

nativeTest.each(['suspend', 'resume', 'lock-screen', 'unlock-screen'])('recreates capture after %s rather than keeping stale media/input resources', async event => {
  const adapter = createRemoteDesktopAdapter();
  const ended = vi.fn();
  await adapter.start({ send: vi.fn(), onEnded: ended });
  mock.power.emit(event);
  expect(ended).toHaveBeenCalledOnce();
  expect(mock.windows[0].destroyed).toBe(true);
  expect(mock.power.eventNames()).toHaveLength(0);
  const next = await adapter.start({ send: vi.fn(), onEnded: ended });
  expect(mock.windows[1].destroyed).toBe(false);
  next.close();
  expect(mock.power.eventNames()).toHaveLength(0);
});

nativeTest('waits for native input readiness before declaring a capture ready', async () => {
  vi.useFakeTimers();
  mock.helperAutoReady = false;
  const send = vi.fn();
  const pending = createRemoteDesktopAdapter().start({ send, onEnded: vi.fn() });
  await vi.advanceTimersByTimeAsync(0);
  expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' }));
  const child = mock.spawn.mock.results[0].value;
  child.stdout.emit('data', Buffer.from('ready\n'));
  const desktop = await pending;
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready' }));
  await desktop.handle({ type: 'key', key: 'Enter' });
  expect(child.stdin.write).toHaveBeenCalled();
  desktop.close();
});
nativeTest('only the owned capture frame can publish media; stop closes all resources and releases input', async () => {
  const send = vi.fn(() => true), ended = vi.fn();
  const adapter = createRemoteDesktopAdapter();
  const desktop = await adapter.start({ send, onEnded: ended, signal: new AbortController().signal, zoomQuality: true });
  const capture = mock.windows.at(-1);
  expect(capture.options.webPreferences).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false });
  expect(mock.spawn.mock.calls[0][1]).toEqual(['123']);
  const child = mock.spawn.mock.results[0].value;
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
  child.stdin.write.mockClear();
  await desktop.handle({ type: 'view', zoomed: true });
  expect(capture.webContents.send).toHaveBeenLastCalledWith('yuri:capture:command', { type: 'view', zoomed: true });
  expect(child.stdin.write).not.toHaveBeenCalled();
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

nativeTest('a locally dropped JPEG invalidates only the capture duplicate history, without changing the wire ACK', async () => {
  const send = vi.fn(() => false);
  const desktop = await createRemoteDesktopAdapter().start({ send, onEnded: vi.fn() });
  const capture = mock.windows.at(-1);
  const owned = { sender: capture.webContents, senderFrame: capture.webContents.mainFrame };
  capture.webContents.send.mockClear();
  mock.ipc.emit('yuri:capture:frame', owned, new ArrayBuffer(10));
  expect(capture.webContents.send).toHaveBeenCalledWith('yuri:capture:command', { type: 'ack', dropped: true });
  await desktop.handle({ type: 'ack' });
  expect(capture.webContents.send).toHaveBeenLastCalledWith('yuri:capture:command', { type: 'ack' });
  desktop.close();
});

nativeTest.each([false, true])('advertises zoom support only when the owning backend opted in (%s)', async zoomQuality => {
  const desktop = await createRemoteDesktopAdapter().start({ send: vi.fn(), onEnded: vi.fn(), zoomQuality });
  const capture = mock.windows.at(-1);
  expect(capture.webContents.send).toHaveBeenCalledWith('yuri:capture:command', expect.objectContaining({ type: 'start', zoomQuality }));
  capture.webContents.send.mockClear();
  await desktop.handle({ type: 'view', zoomed: true });
  expect(capture.webContents.send).toHaveBeenCalledTimes(zoomQuality ? 1 : 0);
  desktop.close();
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
  expect(mock.blocker.start).not.toHaveBeenCalled();
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
