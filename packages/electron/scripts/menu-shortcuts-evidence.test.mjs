import { expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const electronDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test.runIf(process.env.YURI_MENU_SHORTCUT_EVIDENCE === '1').each(['HMR', 'bundled'])(
  'real preload preserves renderer keys and selectively yields native menus (%s)',
  { timeout: 30000 }, async mode => {
    const root = await mkdtemp(path.join(tmpdir(), 'yuri-menu-shortcuts-'));
    const script = path.join(root, 'fixture.mjs');
    await writeFile(script, `
      import { app, BrowserWindow, Menu, ipcMain, protocol } from 'electron';
      import { createServer } from 'node:http';
      import { writeFileSync } from 'node:fs';
      import path from 'node:path';
      import { createMenuShortcuts, isMenuShortcutSender } from ${JSON.stringify(new URL('../menu-shortcuts.mjs', import.meta.url).href)};
      import { createQuitShortcut } from ${JSON.stringify(new URL('../quit-shortcut.mjs', import.meta.url).href)};
      const root = process.argv[2], mode = process.argv[3];
      app.setPath('userData', path.join(root, 'profile'));
      protocol.registerSchemesAsPrivileged([{ scheme: 'yuri-ui', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
      const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
      app.whenReady().then(async () => {
        const html = '<!doctype html><body><h1>menu arbitration fixture</h1><script>window.hits = {}; window.decline = false; document.addEventListener("keydown", event => { const key = event.key.toLowerCase(); if (["m", "p", "q"].includes(key)) window.hits[key] = (window.hits[key] || 0) + 1; if (key === "m" && window.decline) void window.__YURI_DESKTOP__.menuShortcuts.fallback("mod+m").then(result => { window.fallbackResult = result; }); });</script>';
        protocol.handle('yuri-ui', () => new Response(html, { headers: { 'content-type': 'text/html' } }));
        const server = createServer((_req, res) => res.end(html));
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const origin = 'http://127.0.0.1:' + server.address().port;
        ipcMain.on('yuri:window-runtime', event => { event.returnValue = { localUiOrigin: origin, localOrigin: origin, apiBaseUrl: origin }; });
        const host = createMenuShortcuts({ BrowserWindow, Menu, authorize: event => isMenuShortcutSender(event, BrowserWindow, [origin]) });
        app.on('web-contents-created', (_event, contents) => { if (contents.getType() === 'window') host.track(contents); });
        ipcMain.handle('yuri:menu-shortcuts:claim', (event, combos) => host.claim(event, combos));
        ipcMain.handle('yuri:menu-shortcuts:fallback', (event, combo) => host.fallback(event, combo));
        let palette = 0, quitCount = 0;
        const mod = process.platform === 'darwin' ? 'Cmd' : 'Ctrl';
        Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Fixture', submenu: [
          { role: 'minimize' }, { label: 'Palette', accelerator: mod + '+P', click: () => { palette++; } },
        ] }]));
        const win = new BrowserWindow({ width: 500, height: 300, show: true, webPreferences: {
          preload: ${JSON.stringify(path.join(electronDir, 'preload.mjs'))}, sandbox: false, contextIsolation: true,
        } });
        const ignored = [];
        const ignoreMenu = win.webContents.setIgnoreMenuShortcuts.bind(win.webContents);
        win.webContents.setIgnoreMenuShortcuts = value => { ignored.push(value); ignoreMenu(value); };
        const guard = createQuitShortcut({ quit: () => { quitCount++; }, showHint: () => {}, hideHint: () => {} });
        if (process.platform === 'darwin') win.webContents.on('before-input-event', (event, input) => guard.handleInput(event, input, win.webContents));
        const url = mode === 'bundled' ? 'yuri-ui://app/session/fixture' : origin + '/session/fixture';
        await win.loadURL(url);
        app.focus({ steal: true });
        win.show(); win.focus(); win.webContents.focus();
        await pause(200);
        const run = code => win.webContents.executeJavaScript(code);
        const press = async key => {
          app.focus({ steal: true }); win.focus(); win.webContents.focus();
          for (let attempt = 0; attempt < 50 && !win.isFocused(); attempt++) await pause(20);
          if (!win.isFocused()) throw new Error('Fixture could not acquire native window focus');
          const modifiers = [process.platform === 'darwin' ? 'meta' : 'control'];
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers });
          await pause(100);
        };
        await run('window.__YURI_DESKTOP__.menuShortcuts.claim(["mod+m", "mod+p", "mod+q"])');
        await press('M'); await press('M'); await press('P');
        const claimed = { hits: await run('window.hits'), minimized: win.isMinimized(), palette };
        if (process.platform === 'darwin') { await press('Q'); await press('Q'); }
        const guarded = { hits: await run('window.hits'), quitCount };
        await run('window.decline = true');
        await press('M');
        await pause(500);
        const fallback = { hits: await run('window.hits'), minimized: win.isMinimized(), replayed: await run('window.fallbackResult') };
        win.restore(); win.show(); win.focus(); win.webContents.focus(); await pause(100);
        await run('window.__YURI_DESKTOP__.menuShortcuts.claim([])');
        await press('P');
        const unclaimed = { ignored: ignored.at(-1) };
        // sendInputEvent bypasses the OS menu dispatch on macOS; click the actual
        // menu separately to verify its callback remains intact.
        Menu.getApplicationMenu().items[0].submenu.items[1].click({ triggeredByAccelerator: false }, win, win.webContents);
        unclaimed.palette = palette;
        await win.loadURL(mode === 'bundled' ? 'yuri-ui://app/preview.html' : origin + '/api/preview/test');
        const denied = await run('window.__YURI_DESKTOP__.menuShortcuts.claim(["mod+m"]).then(() => false, () => true)');
        guard.cancel();
        writeFileSync(path.join(root, 'result.json'), JSON.stringify({ claimed, guarded, fallback, unclaimed, denied }));
        win.destroy(); server.close(); app.exit(0);
      }).catch(error => { console.error(error); app.exit(1); });
    `);
    const electron = createRequire(import.meta.url)('electron');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    let child;
    try {
      const output = [];
      child = spawn(electron, [script, root, mode], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', chunk => output.push(chunk.toString()));
      child.stderr.on('data', chunk => output.push(chunk.toString()));
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(output.join('') || 'Electron fixture timed out')); }, 25000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('exit', status => { clearTimeout(timer); resolve(status); });
      });
      expect(code, output.join('')).toBe(0);
      const result = JSON.parse(await readFile(path.join(root, 'result.json'), 'utf8'));
      expect(result.claimed, JSON.stringify(result)).toEqual({ hits: { m: 2, p: 1 }, minimized: false, palette: 0 });
      if (process.platform === 'darwin') expect(result.guarded).toEqual({ hits: { m: 2, p: 1 }, quitCount: 1 });
      expect(result.fallback.hits.m).toBe(3);
      expect(result.fallback.minimized, JSON.stringify(result)).toBe(true);
      expect(result.fallback.replayed, JSON.stringify(result)).toBe(true);
      expect(result.unclaimed.palette, JSON.stringify(result)).toBe(1);
      expect(result.unclaimed.ignored).toBe(false);
      expect(result.denied).toBe(true);
    } finally {
      child?.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    }
  },
);
