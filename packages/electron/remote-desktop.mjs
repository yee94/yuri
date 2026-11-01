import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, screen, session, shell, systemPreferences } from 'electron';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const failure = (code) => Object.assign(new Error(code), { code });

export function createRemoteDesktopAdapter({ approvalsStore } = {}) {
  const owners = new Set();
  const approvedIds = root => Array.isArray(root?.clients)
    ? root.clients.filter(id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id)).slice(0, 256) : [];
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
    async start({ send, onEnded, signal, client }) {
      if (process.platform !== 'darwin') throw failure('unsupported');
      if (!enabled()) throw failure('disabled');
      if (!fs.existsSync(helper())) throw failure('helper_unavailable');
      const abort = new AbortController();
      let win, status, child, disposed = false;
      let readyTimer;
      const partition = session.fromPartition('remote-desktop-capture');
      const cleanups = [];
      const close = () => {
        if (disposed) return;
        disposed = true;
        owners.delete(end);
        abort.abort();
        clearTimeout(readyTimer);
        for (const cleanup of cleanups) cleanup();
        partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        partition.setPermissionCheckHandler(() => false);
        if (child) { child.stdin.end(); const current = child; setTimeout(() => { if (current.exitCode === null) current.kill(); }, 1000).unref(); }
        if (win && !win.isDestroyed()) win.destroy();
        if (status && !status.isDestroyed()) status.destroy();
      };
      const end = () => { close(); onEnded(); };
      owners.add(end);
      signal?.addEventListener('abort', close, { once: true });
      cleanups.push(() => signal?.removeEventListener('abort', close));
      try {
        if (signal?.aborted) throw failure('permission_denied');
        const clientId = typeof client?.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(client.id) ? client.id : null;
        const remembered = clientId && approvalsStore && approvedIds(approvalsStore.readRoot()).includes(clientId);
        const consent = remembered ? { response: 1, checkboxChecked: false } : await dialog.showMessageBox({
          type: 'warning', title: 'Yuri · 远程桌面 / Remote desktop',
          message: '允许已配对的设备查看并控制此 Mac？\nAllow the paired device to view and control this Mac?',
          detail: `${String(client?.label ?? '').replace(/[\r\n]/g, ' ').slice(0, 100)}\n将共享主屏幕。可在共享窗口停止或取消信任此设备。\nThe primary display will be shared. Stop or forget this device in the sharing window.`,
          ...(clientId && approvalsStore ? { checkboxLabel: '始终允许此设备 / Always allow this device', checkboxChecked: false } : {}),
          buttons: ['取消 / Cancel', '允许 / Allow'], defaultId: 0, cancelId: 0, signal: abort.signal,
        });
        if (disposed || consent.response !== 1) throw failure('permission_denied');
        if (!enabled()) throw failure('disabled');
        if (!systemPreferences.isTrustedAccessibilityClient(true)) throw failure('permission_required');
        const display = screen.getPrimaryDisplay();
        status = new BrowserWindow({ show: false, width: 360, height: 130,
          x: display.workArea.x + Math.max(0, display.workArea.width - 372), y: display.workArea.y + 12,
          resizable: false, alwaysOnTop: true, autoHideMenuBar: true,
          title: 'Yuri · 远程桌面 / Remote desktop', webPreferences: {
            preload: path.join(app.getAppPath(), 'remote-desktop-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true,
          } });
        status.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        status.webContents.on('will-navigate', event => event.preventDefault());
        const stopFromStatus = event => {
          if (!disposed && event.sender === status.webContents && event.senderFrame === status.webContents.mainFrame) onEnded();
        };
        ipcMain.on('yuri:capture:stop', stopFromStatus);
        cleanups.push(() => ipcMain.off('yuri:capture:stop', stopFromStatus));
        const forgetFromStatus = event => {
          if (disposed || event.sender !== status.webContents || event.senderFrame !== status.webContents.mainFrame) return;
          const forget = clientId && approvalsStore ? approvalsStore.mutate(root => {
            root.clients = approvedIds(root).filter(id => id !== clientId);
          }) : Promise.resolve();
          onEnded();
          void forget.catch(() => dialog.showErrorBox('Yuri', '无法取消设备信任，请在设备管理中撤销配对。\nCould not forget this device. Revoke its pairing in device management.'));
        };
        ipcMain.on('yuri:capture:forget', forgetFromStatus);
        cleanups.push(() => ipcMain.off('yuri:capture:forget', forgetFromStatus));
        status.on('closed', () => { if (!disposed) onEnded(); });
        await status.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>:root{color-scheme:light dark}body{font:13px system-ui;padding:8px;text-align:center}button{font:inherit;padding:8px}</style><p>正在共享屏幕 / Sharing your screen</p><button onclick="captureBridge.stop()">停止 / Stop</button> <button onclick="captureBridge.forget()">取消信任 / Forget device</button>`)}`);
        if (disposed || !enabled()) throw failure('permission_denied');
        status.showInactive();
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
        if (clientId && consent.checkboxChecked && approvalsStore && !disposed) {
          await approvalsStore.mutate(root => {
            if (disposed || signal?.aborted) throw failure('permission_denied');
            root.clients = [...new Set([...approvedIds(root).filter(id => id !== clientId).slice(-255), clientId])];
          });
        }
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
