import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createGuiPluginMainHost } from './gui-plugin-host.mjs';
import { isGuiPluginUiUrl } from './gui-plugin-origin.mjs';
import { isRemoteIpcCommandAllowed } from './ipc-command-gate.mjs';

const source = readFileSync(fileURLToPath(new URL('./main.mjs', import.meta.url)), 'utf8');
const localChecks = source.slice(source.indexOf('const isLocalUiSender ='), source.indexOf('const guiPluginHost ='));
const assetHandlers = source.slice(source.indexOf('const requireLocalAssetSender ='), source.indexOf('const requirePreviewGatewayOwner ='));

function fixture(url = 'yuri-ui://app/session/test') {
  const owner = Object.assign(new EventEmitter(), { id: 1, getURL: () => url, mainFrame: { url } });
  const event = { sender: owner, senderFrame: owner.mainFrame };
  const window = {};
  const BrowserWindow = { fromWebContents: (contents) => contents === owner ? window : null };
  const state = { localOrigin: 'http://127.0.0.1:3901', localUiOrigin: 'http://localhost:5173' };
  let checks;
  const host = createGuiPluginMainHost({
    app: new EventEmitter(), windows: BrowserWindow, getClient: () => { throw new Error('No local plugin execution'); },
    authorizeWindow: (received) => checks.isGuiPluginWindow(received),
    authorize: (received) => checks.isLocalSender(received.sender), send: vi.fn(), report: vi.fn(),
  });
  checks = new Function('state', 'UI_PROTOCOL', 'guiPluginHost', 'BrowserWindow', 'isGuiPluginUiUrl',
    `${localChecks}\nreturn { isLocalSender, isGuiPluginWindow };`)(state, 'yuri-ui', host, BrowserWindow, isGuiPluginUiUrl);
  const handlers = new Map();
  const invoke = vi.fn(async () => null);
  const invokeSource = source.slice(source.indexOf("ipcMain.handle('yuri:invoke'"), source.indexOf("ipcMain.handle('yuri:dialog:open'"));
  new Function('ipcMain', 'isLocalSender', 'isGuiPluginWindow', 'isRemoteIpcCommandAllowed', 'BrowserWindow', 'handleInvoke', 'log', invokeSource)(
    { handle: (channel, handler) => handlers.set(channel, handler) }, checks.isLocalSender, checks.isGuiPluginWindow,
    isRemoteIpcCommandAllowed, BrowserWindow, invoke, { warn: vi.fn() });
  const imageDiskCache = Object.fromEntries(['lookup', 'clear', 'acquire', 'append', 'commit', 'release', 'releaseOwner']
    .map((name) => [name, vi.fn(async () => ({ leaseId: 'lease', url: 'yuri-asset://cache/test' }))]));
  const virtualAssetRegistry = Object.fromEntries(['create', 'push', 'finish', 'cancel']
    .map((name) => [name, vi.fn(async () => ({ assetId: 'asset' }))]));
  const previewGate = new Function('ipcMain', 'isLocalSender', 'isGuiPluginWindow', 'imageDiskCache', 'virtualAssetRegistry', 'log',
    `${assetHandlers}\nreturn requireLocalPreviewGatewaySender;`)(
    { handle: (channel, handler) => handlers.set(channel, handler) }, checks.isLocalSender, checks.isGuiPluginWindow,
    imageDiskCache, virtualAssetRegistry, { warn: vi.fn() });
  const syncHandlers = new Map();
  const runtimeSource = source.slice(source.indexOf("ipcMain.on('yuri:window-runtime'"), source.indexOf("ipcMain.handle('yuri:invoke'"));
  new Function('ipcMain', 'isGuiPluginWindow', 'guiPluginHost', 'BrowserWindow', 'getWindowRuntimeConfig', 'state', 'isGuiPluginUiUrl', runtimeSource)(
    { on: (channel, handler) => syncHandlers.set(channel, handler) }, checks.isGuiPluginWindow, host, BrowserWindow,
    () => ({ apiBaseUrl: 'http://remote.invalid', clientToken: 'fixture-token', requestHeaders: {} }), state, isGuiPluginUiUrl);
  return { window, owner, event, host, checks, handlers, invoke, syncHandlers, imageDiskCache, virtualAssetRegistry, previewGate };
}

describe('application presentation IPC in window-only documents', () => {
  it.each(['yuri-ui://app/session/test', 'http://localhost:5173/session/test',
    'yuri-ui://app/plugins/example/board', 'http://localhost:5173/plugins/example/board'])(
    'keeps image and preview bridges usable after real plugin restriction: %s', async (url) => {
      const f = fixture(url);
      try {
        await f.host.handle(f.event, 'window-only');
        expect(f.host.isWindowOnly(f.owner)).toBe(true);
        expect(f.checks.isLocalSender(f.owner)).toBe(false);
        for (const [channel, handler] of f.handlers) {
          if (channel === 'yuri:invoke') continue;
          await expect(Promise.resolve().then(() => handler(f.event, {
            key: '0'.repeat(64), size: 1, leaseId: 'lease', assetId: 'asset', mimeType: 'image/png',
            mime: 'image/png', chunk: new Uint8Array([1]),
          })), channel).resolves.toBeDefined();
        }
        expect(() => f.previewGate(f.event, 'preview-gateway:ensure')).not.toThrow();
        expect(f.imageDiskCache.acquire).toHaveBeenCalledWith(f.owner.id, expect.objectContaining({ size: 1 }));
        expect(f.imageDiskCache.append).toHaveBeenCalledWith(f.owner.id, 'lease', expect.any(Uint8Array));
        await expect(f.host.handle(f.event, 'acquire', { id: 'test', revision: 'r1' }))
          .rejects.toMatchObject({ code: 'GUI_PLUGIN_DOCUMENT_RESTRICTED' });
      } finally { await f.host.dispose(); }
    });

  it.each(['https://remote.invalid/', 'yuri-ui://app/api/fs/raw', 'yuri-ui://app/preview.html',
    'http://localhost:5173/api/preview/test', 'file:///index.html'])(
    'rejects non-application documents: %s', async (url) => {
      const f = fixture(url);
      try {
        for (const handler of f.handlers.values()) {
          if (handler === f.handlers.get('yuri:invoke')) continue;
          await expect(Promise.resolve().then(() => handler(f.event, {}))).rejects.toThrow('IPC not available');
        }
        expect(() => f.previewGate(f.event, 'preview-gateway:ensure')).toThrow('IPC not available');
        expect(f.imageDiskCache.acquire).not.toHaveBeenCalled();
        expect(f.virtualAssetRegistry.create).not.toHaveBeenCalled();
      } finally { await f.host.dispose(); }
    });

  it('rejects iframe and stale frame senders even inside an application window', async () => {
    const f = fixture();
    try {
      for (const senderFrame of [{ url: f.owner.getURL() }, null]) {
        const event = { ...f.event, senderFrame };
        await expect(f.handlers.get('yuri:image-cache:acquire')(event, {})).rejects.toThrow('IPC not available');
        expect(() => f.previewGate(event, 'preview-gateway:ensure')).toThrow('IPC not available');
      }
      f.owner.mainFrame.url = 'yuri-ui://app/preview.html';
      await expect(f.handlers.get('yuri:image-cache:acquire')(f.event, {})).rejects.toThrow('IPC not available');
      expect(() => f.previewGate(f.event, 'preview-gateway:ensure')).toThrow('IPC not available');
    } finally { await f.host.dispose(); }
  });

  it('keeps validated window identity updates available without restoring privileged SSH/file IPC', async () => {
    const f = fixture();
    try {
      await f.host.handle(f.event, 'window-only');
      const invoke = f.handlers.get('yuri:invoke');
      await expect(invoke(f.event, 'desktop_window_runtime_set', { runtimeKey: 'host:fixture' })).resolves.toBeNull();
      for (const command of ['desktop_ssh_connect', 'desktop_ssh_instances_set', 'desktop_open_path']) {
        await expect(invoke(f.event, command, {})).rejects.toThrow('IPC not available');
      }
      await expect(invoke({ ...f.event, senderFrame: {} }, 'desktop_window_runtime_set', {})).rejects.toThrow('main desktop frame');
    } finally { await f.host.dispose(); }
  });

  it.each(['https://remote.invalid/', 'yuri-ui://app/api/fs/raw'])('does not hand runtime credentials to %s', async (url) => {
    const f = fixture(url);
    try {
      f.syncHandlers.get('yuri:window-runtime')(f.event);
      expect(f.event.returnValue).toBeNull();
    } finally { await f.host.dispose(); }
  });

  it('only provides the preload snapshot to an unrestricted application main frame', async () => {
    const f = fixture();
    try {
      const snapshot = f.syncHandlers.get('yuri:window-runtime');
      const iframe = { ...f.event, senderFrame: {} };
      snapshot(iframe);
      expect(iframe.returnValue).toBeNull();
      const replies = [];
      Object.defineProperty(f.event, 'returnValue', { configurable: true, set: value => replies.push(value) });
      snapshot(f.event);
      expect(replies).toEqual([expect.objectContaining({ clientToken: 'fixture-token' })]);
      await f.host.handle(f.event, 'window-only');
      snapshot(f.event);
      expect(replies).toHaveLength(2);
      expect(replies[1]).toBeNull();
    } finally { await f.host.dispose(); }
  });

  it('only returns non-secret routing state to a saved remote application document', async () => {
    const f = fixture('http://remote.invalid/session/test');
    try {
      f.window.__yuriRuntimeConfig = { apiBaseUrl: 'http://remote.invalid' };
      f.window.__yuriBootOutcome = { target: 'remote', hostId: 'fixture', status: 'ok' };
      f.syncHandlers.get('yuri:window-runtime')(f.event);
      expect(f.event.returnValue).toEqual({ apiBaseUrl: 'http://remote.invalid', bootOutcome: f.window.__yuriBootOutcome });
      expect(JSON.stringify(f.event.returnValue)).not.toContain('fixture-token');
    } finally { await f.host.dispose(); }
  });
});
