import { app, BrowserWindow, ipcMain, nativeImage, protocol } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuiPluginMainHost } from '../gui-plugin-host.mjs';
import { isGuiPluginUiUrl } from '../gui-plugin-origin.mjs';
import { createPluginDockIcons } from '../plugin-dock-icons.mjs';

const directory = process.env.YURI_TEST_EVIDENCE_DIR;
const mode = process.env.YURI_GUI_TEST_MODE;
app.setPath('userData', path.join(directory, `profile-${mode}`));
protocol.registerSchemesAsPrivileged([{ scheme: 'yuri-ui', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const source = `
  const {Plugin,Ipc,Command,TitlebarItem,Registry,Style}=require('@opencode/plugin/gui');
  const {Schema}=require('effect');
  const {BrowserWindow}=require('electron');
  const Export=Ipc.define({id:'pdf-fixture.export',methods:{pdf:{input:Schema.String,output:Schema.String}}});
  module.exports=Plugin.define({
    setup(ctx){
      if(ctx.app.platform!=='desktop'||!ctx.desktop.os) throw new Error('Desktop metadata missing');
      const api=ctx.main(Export);
       const run=async()=>{
        const pdf=await api.pdf('<html><body><h1>Native plugin PDF</h1><p>Selectable text</p></body></html>');
        document.documentElement.dataset.pdf=pdf;
       };
       ctx.add(Command,{id:'export',title:'Export',run});
       ctx.add(TitlebarItem,{id:'export',label:'Export',icon:'globe',run});
       ctx.add(Registry.define('yuri.theme'),{id:'ink',title:'Ink',variant:'dark',colors:{primary:{base:'#123456'}}});
       ctx.add(Registry.define('yuri.branding'),{id:'logo',title:'Logo',logo:{svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/></svg>'}});
       ctx.add(Style, ':root,:root:not(.dark){--surface-background:rgb(12, 34, 56)}');
    },
    main(ctx){
      const live=new Set();
      ctx.onCleanup(()=>{for(const win of live)win.destroy()});
      ctx.provide(Export,{pdf:async(html,caller)=>{
        if(!ctx.windows.get(caller.window))throw new Error('Invalid calling window');
        const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});
        live.add(win);
        try{
          await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
          const bytes=await win.webContents.printToPDF({printBackground:true,pageSize:'A4'});
          return bytes.toString('base64');
        }finally{live.delete(win);win.destroy()}
      }});
    }
  });
`;
let host;
let dockUpdates = 0;
let dockRestores = 0;
app.whenReady().then(async () => {
try {
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><script>window.process={env:{NODE_ENV:"production"}}</script><script type="module" src="/fixture.js"></script></body></html>';
  const script = await readFile(path.join(directory, 'fixture.js'));
  let origin = 'yuri-ui://app';
  if (mode === 'hmr') {
    origin = process.env.YURI_GUI_TEST_ORIGIN;
  } else protocol.handle('yuri-ui', (request) => new Response(request.url.endsWith('fixture.js') ? script : html, {
    headers: { 'Content-Type': request.url.endsWith('fixture.js') ? 'text/javascript' : 'text/html' },
  }));
  const window = new BrowserWindow({ show: false, webPreferences: {
    preload: fileURLToPath(new URL('../preload.mjs', import.meta.url)), sandbox: false, contextIsolation: true, nodeIntegration: false,
    additionalArguments: [`--yuri-local-origin=${origin}`, '--yuri-packaged=0'],
  } });
  window.webContents.on('console-message', (event) => console.error(event.message));
  host = createGuiPluginMainHost({
    app, windows: BrowserWindow,
    dockIcons: process.platform === 'darwin' ? createPluginDockIcons({
      decode: (source) => nativeImage.createFromDataURL(source),
      apply: (image) => {
        if (image) { app.dock.setIcon(image); dockUpdates++; }
        else dockRestores++;
      },
    }) : undefined,
    getClient: () => ({ plugin: {
      list: async () => ({ data: [{ id: 'pdf-fixture', features: { gui: true }, state: { status: 'active' } }] }),
      gui: async () => ({ data: { code: source, revision: '1', options: {} } }),
    } }),
    authorize: (event) => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
      && isGuiPluginUiUrl(window.webContents.getURL(), [origin]),
    send: (contents, payload) => contents.send('yuri:gui-plugin:event', payload),
  });
  ipcMain.handle('yuri:gui-plugin', (event, action, input) => host.dispatch(event, action, input));
  await window.loadURL(`${origin}/plugins/pdf-fixture/board`);
  const result = await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
    const until=Date.now()+20000;
    const timer=setInterval(()=>{
      if(document.documentElement.dataset.finished){clearInterval(timer);resolve(document.documentElement.dataset.pdf)}
      else if(Date.now()>until){clearInterval(timer);reject(new Error('PDF fixture timed out'))}
    },25);
  })`);
  const pdf = Buffer.from(result, 'base64');
  if (pdf.subarray(0, 5).toString() !== '%PDF-' || pdf.length < 1000) throw new Error('Invalid PDF output');
  if (process.platform === 'darwin' && (dockUpdates !== 1 || dockRestores !== 1)) throw new Error('Dock lease update/cleanup was not confirmed');
  await writeFile(path.join(directory, `${mode}.pdf`), pdf);
  await host.dispose();
  window.destroy();
  app.exit(0);
} catch (error) {
  console.error(error);
  await host?.dispose();
  app.exit(1);
}
});
