import { app, BrowserWindow, desktopCapturer, ipcMain, screen, session, shell, systemPreferences } from 'electron';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const failure = (code) => Object.assign(new Error(code), { code });

export function createRemoteDesktopAdapter({ approvalsStore } = {}) {
  const owners = new Set();
  const helper = () => path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), app.isPackaged ? 'remote-desktop' : 'resources/remote-desktop', 'input-helper');
  let blocked = false;
  let changes = Promise.resolve();
  const enabled = () => process.platform === 'darwin' && !blocked && approvalsStore?.readRoot()?.enabled === true;
  const stop = () => { for (const end of [...owners]) end(); };
  const helperAccessibility = async (prompt = false) => {
    if (!fs.existsSync(helper())) return false;
    try {
      return await new Promise(resolve => {
        execFile(helper(), [prompt ? '--request-accessibility' : '--check-accessibility'],
          { timeout: 3000, maxBuffer: 1024, windowsHide: true },
          (error, stdout) => resolve(!error && stdout.trim() === 'granted'));
      });
    } catch { return false; }
  };
  const getStatus = async () => {
    const supported = process.platform === 'darwin';
    const helperAvailable = supported && fs.existsSync(helper());
    const screenRecording = supported ? systemPreferences.getMediaAccessStatus('screen') : 'unknown';
    const accessibility = supported && systemPreferences.isTrustedAccessibilityClient(false) && await helperAccessibility();
    return { supported, enabled: enabled(), screenRecording, accessibility, helperAvailable,
      ready: supported && helperAvailable && screenRecording === 'granted' && accessibility };
  };
  return {
    supported: process.platform === 'darwin',
    get enabled() { return enabled(); },
    getStatus,
    async setEnabled(value) {
      if (typeof value !== 'boolean') throw failure('invalid_setting');
      const change = changes.then(async () => {
        if (!approvalsStore || process.platform !== 'darwin') throw failure('unsupported');
        if (value && !(await getStatus()).ready) throw failure('permission_required');
        if (!value) { blocked = true; stop(); }
        await approvalsStore.mutate(root => { root.enabled = value; });
        blocked = !value;
        return getStatus();
      });
      changes = change.catch(() => {});
      return change;
    },
    async requestPermission(permission) {
      if (process.platform !== 'darwin') throw failure('unsupported');
      if (permission === 'screen') {
        if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
          try { await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }); }
          catch { /* Denial remains visible in the authoritative permission status. */ }
        }
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      } else if (permission === 'accessibility') {
        systemPreferences.isTrustedAccessibilityClient(true);
        await helperAccessibility(true);
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
      } else throw failure('invalid_permission');
      return getStatus();
    },
    async start({ send, onEnded, signal }) {
      if (process.platform !== 'darwin') throw failure('unsupported');
      if (!enabled()) throw failure('disabled');
      if (!fs.existsSync(helper())) throw failure('helper_unavailable');
      let win, child, disposed = false;
      let readyTimer;
      const partition = session.fromPartition('remote-desktop-capture');
      const cleanups = [];
      const close = () => {
        if (disposed) return;
        disposed = true;
        owners.delete(end);
        clearTimeout(readyTimer);
        for (const cleanup of cleanups) cleanup();
        partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        partition.setPermissionCheckHandler(() => false);
        if (child) { child.stdin.end(); const current = child; setTimeout(() => { if (current.exitCode === null) current.kill(); }, 1000).unref(); }
        if (win && !win.isDestroyed()) win.destroy();
      };
      const end = () => { close(); onEnded(); };
      owners.add(end);
      signal?.addEventListener('abort', close, { once: true });
      cleanups.push(() => signal?.removeEventListener('abort', close));
      try {
        if (signal?.aborted) throw failure('permission_denied');
        const permissions = await getStatus();
        if (disposed) throw failure('permission_denied');
        if (!enabled()) throw failure('disabled');
        if (!permissions.ready) throw failure('permission_required');
        const display = screen.getPrimaryDisplay();
        const displayChanged = () => { if (!disposed) onEnded(); };
        screen.on('display-removed', displayChanged);
        screen.on('display-metrics-changed', displayChanged);
        cleanups.push(() => { screen.off('display-removed', displayChanged); screen.off('display-metrics-changed', displayChanged); });
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
        if (disposed) throw failure('permission_denied');
        const source = sources.find(item => item.display_id === String(display.id));
        if (!source) throw failure('permission_required');
        // A separate session prevents runtime pages/plugins inheriting capture permissions.
        partition.setPermissionRequestHandler((contents, permission, callback) => callback(contents === win?.webContents && ['media', 'display-capture'].includes(permission)));
        partition.setPermissionCheckHandler((contents, permission) => contents === win?.webContents && ['media', 'display-capture'].includes(permission));
        win = new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: {
          session: partition, preload: path.join(app.getAppPath(), 'remote-desktop-preload.cjs'),
          nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false,
        } });
        win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        win.webContents.on('will-navigate', event => event.preventDefault());
        win.webContents.on('render-process-gone', onEnded);
        child = spawn(helper(), [String(display.id)], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        child.on('error', onEnded);
        child.on('exit', () => { if (!disposed) onEnded(); });
        child.stdin.on('error', () => { if (!disposed) onEnded(); });
        let helperReady = false;
        let helperOutput = '';
        child.stdout.on('data', bytes => {
          helperOutput += bytes.toString();
          if (helperOutput.length > 256) { if (!disposed) onEnded(); return; }
          if (!helperOutput.includes('\n')) return;
          if (helperOutput.trim() === 'ready') helperReady = true;
          else if (!disposed) onEnded();
        });
        const validSender = event => !disposed && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
        const listen = (channel, callback) => {
          const handler = (event, payload) => { if (validSender(event)) callback(payload); };
          ipcMain.on(channel, handler);
          cleanups.push(() => ipcMain.off(channel, handler));
        };
        const sendCommand = message => { if (!disposed) win.webContents.send('yuri:capture:command', message); };
        let iceServers = [];
        // Optional deployment-owned TURN/STUN configuration, never persisted in the client.
        if (process.env.YURI_REMOTE_DESKTOP_ICE_SERVERS) {
          const parsed = JSON.parse(process.env.YURI_REMOTE_DESKTOP_ICE_SERVERS);
          if (!Array.isArray(parsed) || parsed.length > 8) throw failure('desktop_failed');
          iceServers = parsed;
        }
        let resolveReady, rejectReady;
        const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
        void ready.catch(() => {});
        cleanups.push(() => rejectReady(failure('desktop_ended')));
        readyTimer = setTimeout(() => rejectReady(failure('permission_required')), 15000);
        listen('yuri:capture:loaded', () => sendCommand({ type: 'start', sourceId: source.id, iceServers }));
        listen('yuri:capture:message', message => {
          if (message?.type === 'failure') { rejectReady(failure('permission_required')); onEnded(); return; }
          if (message?.type === 'ready') { clearTimeout(readyTimer); resolveReady(); }
          if (['ready', 'offer', 'ice', 'transport', 'rtc-failed'].includes(message?.type)) send(message.type === 'offer' ? { ...message, iceServers } : message);
        });
        listen('yuri:capture:frame', bytes => {
          if (bytes instanceof ArrayBuffer && bytes.byteLength <= 512 * 1024 && !send(Buffer.from(bytes))) sendCommand({ type: 'ack' });
        });
        await win.loadFile(path.join(app.getAppPath(), 'remote-desktop.html'));
        await ready;
        if (disposed) throw failure('permission_denied');
        return {
          async handle(message) {
            if (disposed) return;
            if (['answer', 'ice', 'fallback', 'ack'].includes(message.type)) { sendCommand(message); return; }
            if (!helperReady) throw failure('permission_required');
            if (child.stdin.writableLength > 32768) throw failure('desktop_failed');
            child.stdin.write(`${JSON.stringify(message)}\n`);
          },
          close,
        };
      } catch (error) { close(); throw error; }
    },
    stop,
  };
}
