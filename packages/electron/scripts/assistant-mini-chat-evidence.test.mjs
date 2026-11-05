import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build, createServer } from 'vite';
import { expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../../', import.meta.url));

test.skip('real Electron: Assistant Mini Chat window, shared pin controls and same-runtime handoff in HMR and bundled UI', { timeout: 120000 }, async () => {
  const work = await mkdtemp(join(process.env.YURI_TEST_EVIDENCE_DIR || tmpdir(), 'assistant-mini-chat-'));
  let server;
  try {
    const entry = `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {MiniChatWindowHeader} from '${resolve(root, 'packages/ui/src/components/mini-chat/MiniChatWindowHeader.tsx')}';
      import {I18nProvider} from '${resolve(root, 'packages/ui/src/lib/i18n/index.ts')}';
      createRoot(document.getElementById('root')).render(React.createElement(I18nProvider,null,React.createElement(MiniChatWindowHeader,
        {mainWindowTarget:{assistantID:'bot-a'}}, React.createElement('span',null,'Bot A'))));
    `;
    const html = (script) => `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script>window.process={env:{NODE_ENV:'development'}}</script><script type="module" src="${script}"></script></body></html>`;
    const virtual = { name: 'mini-chat-evidence', resolveId: (id) => id.endsWith('virtual:mini-chat-evidence') ? '\0mini-chat-evidence' : undefined,
      load: (id) => id === '\0mini-chat-evidence' ? entry : undefined };
    const options = { configFile: false, root: resolve(root, 'packages/ui'), publicDir: false, define: { 'process.env.NODE_ENV': '"development"' },
      resolve: { conditions: ['browser'], dedupe: ['react', 'react-dom'], alias: { '@': resolve(root, 'packages/ui/src') } }, plugins: [virtual] };
    await build({ ...options, build: { outDir: work, emptyOutDir: false, target: 'esnext', minify: false,
      lib: { entry: 'virtual:mini-chat-evidence', formats: ['es'], fileName: () => 'fixture.js' } } });
    server = await createServer({ ...options, server: { host: '127.0.0.1', port: 0 }, plugins: [virtual, {
      name: 'mini-chat-evidence-page', configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (!request.url?.startsWith('/mini-chat.html') && !request.url?.startsWith('/assistant/')) return next();
          response.setHeader('Content-Type', 'text/html'); response.end(html('/@id/virtual:mini-chat-evidence'));
        });
      },
    }] });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const main = await readFile(resolve(root, 'packages/electron/main.mjs'), 'utf8');
    const production = main.slice(main.indexOf('const buildMiniChatUrl ='), main.indexOf('const resolveMiniChatRuntimeConfig ='));
    const launcher = `
      import {app,BrowserWindow,ipcMain,protocol} from 'electron';
      import {readFile,writeFile} from 'node:fs/promises';
      import path from 'node:path';
      import os from 'node:os';
      import assert from 'node:assert/strict';
      const work=${JSON.stringify(work)},mode=process.argv[2],origin=${JSON.stringify(origin)};
      app.setPath('userData',path.join(work,'profile-'+mode));
      protocol.registerSchemesAsPrivileged([{scheme:'yuri-ui',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
      app.on('window-all-closed',()=>{});
      const state={localOrigin:origin,localUiOrigin:origin,sidecarUrl:origin,apiBaseUrl:origin,clientToken:'',requestHeaders:{},miniChatWindowsBySession:new Map()};
      const shouldUsePackagedUi=()=>mode==='packaged',buildPackagedUiUrl=(route)=>'yuri-ui://app'+route;
      const normalizeHostUrl=(url)=>url.replace(/\\/$/,''),sanitizeClientTokenForStorage=(token)=>token||'',sanitizeRuntimeRequestHeaders=(headers)=>headers||{};
      const macosMajorVersion=()=>0,readSettingsRoot=()=>({desktopVibrancy:false});
      const MINI_CHAT_WINDOW_WIDTH=520,MINI_CHAT_WINDOW_HEIGHT=760,MINI_CHAT_MIN_WINDOW_WIDTH=360,MINI_CHAT_MIN_WINDOW_HEIGHT=480;
      const APP_USER_MODEL_ID='test.yuri',isDev=true,__dirname=${JSON.stringify(resolve(root, 'packages/electron'))};
      const getWindowIconPath=()=>undefined,nextWindowLabel=()=>String(BrowserWindow.getAllWindows().length);
      const trackMacWindowVibrancy=()=>{},buildInitScript=()=>'',resolveWindowInitScript=()=>'',setMacVibrancyReady=()=>{},scheduleMacVibrancyReady=()=>{};
      const presentBrowserWindow=(window)=>window.show(),navigateWindow=(window,url)=>{window.webContents.on('console-message',(event)=>console.error(event.message));return window.loadURL(url)};
      const emitToWindow=(window,event,detail)=>window.webContents.send('yuri:emit',{event,detail});
      const createAdditionalWindow=async(url,runtime)=>{const window=new BrowserWindow({show:false});window.__yuriLabel='primary';window.__yuriRuntimeConfig=runtime;await window.loadURL(url);return window};
      ${production}
      const wait=async(window,expression)=>window.webContents.executeJavaScript('new Promise((resolve,reject)=>{const end=Date.now()+15000;const timer=setInterval(()=>{if('+expression+'){clearInterval(timer);resolve(true)}else if(Date.now()>end){clearInterval(timer);reject(new Error("renderer timeout"))}},25)})');
      app.whenReady().then(async()=>{try{
        if(mode==='packaged') protocol.handle('yuri-ui',async(request)=>new Response(
          new URL(request.url).pathname==='/fixture.js'?await readFile(path.join(work,'fixture.js')):${JSON.stringify(html('/fixture.js'))},
          {headers:{'Content-Type':new URL(request.url).pathname==='/fixture.js'?'text/javascript':'text/html'}}));
        ipcMain.handle('yuri:invoke',(event,command,args)=>{
          const window=BrowserWindow.fromWebContents(event.sender);
          if(command==='desktop_get_window_pinned')return {pinned:Boolean(window.__yuriPinned)};
          if(command==='desktop_set_window_pinned')return setMiniChatPinned(window,args.pinned);
          if(command==='desktop_focus_main_window')return focusAssistantMiniChatTarget(window,args);
          if(command==='desktop_close_current_window'){window.close();return null}
          return null;
        });
        const window=await createMiniChatWindow({mode:'assistant',assistantID:'bot-a'});
        await wait(window,'document.querySelector("button[aria-pressed]")');
        assert.equal(new URL(window.webContents.getURL()).searchParams.get('assistantID'),'bot-a');
        await window.webContents.executeJavaScript('document.querySelector("button[aria-pressed]").click()');
        await wait(window,'document.querySelector("button[aria-pressed]").getAttribute("aria-pressed")==="true"');
        assert.equal(window.isAlwaysOnTop(),true);
        assert.equal(await createMiniChatWindow({mode:'assistant',assistantID:'bot-a'}),window);
        await window.webContents.executeJavaScript('document.querySelector("button[aria-pressed]").click()');
        await wait(window,'document.querySelector("button[aria-pressed]").getAttribute("aria-pressed")==="false"');
        assert.equal(window.isAlwaysOnTop(),false);
        await window.webContents.executeJavaScript('document.querySelectorAll("header button")[1].click()');
        await new Promise((resolve,reject)=>{if(window.isDestroyed())return resolve();window.once('closed',resolve);setTimeout(()=>reject(new Error('handoff timeout')),15000)});
        const primary=BrowserWindow.getAllWindows().find(candidate=>candidate.__yuriLabel==='primary');
        assert.equal(new URL(primary.webContents.getURL()).pathname,'/assistant/bot-a');
        assert.equal(state.miniChatWindowsBySession.size,0);
        await writeFile(path.join(work,mode+'.json'),JSON.stringify({mode,pin:true,unpin:true,deduplicated:true,handoff:true}));
        app.exit(0);
      }catch(error){console.error(error);app.exit(1)}});
    `;
    const script = join(work, 'launch.mjs'); await writeFile(script, launcher);
    for (const mode of ['hmr', 'packaged']) {
      await new Promise((done, reject) => {
        const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
        const child = spawn(require('electron'), [script, mode], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stderr.on('data', (data) => { output += data; }); child.stdout.on('data', (data) => { output += data; });
        const timeout = setTimeout(() => { child.kill(); reject(new Error(output.slice(-6000))); }, 45000);
        child.once('error', (error) => { clearTimeout(timeout); reject(error); });
        child.once('exit', (code) => { clearTimeout(timeout); code === 0 ? done() : reject(new Error(output.slice(-6000))); });
      });
      expect(JSON.parse(await readFile(join(work, `${mode}.json`), 'utf8'))).toEqual({ mode, pin: true, unpin: true, deduplicated: true, handoff: true });
    }
  } finally {
    await server?.close();
    if (!process.env.YURI_TEST_EVIDENCE_DIR) await rm(work, { recursive: true, force: true });
  }
});
