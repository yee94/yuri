import { QueryClient } from '@tanstack/react-query';
import { GuiPluginHost } from './host';
import { NativeGuiSession } from './native';
import type { NativeGuiActivation, NativeGuiBridge } from './native-types';
import type { FilesAPI } from '@/lib/api/types';
import type { OpenCodeClient } from '@yuriai/opencode-gui-client';
import { NativeGuiError, requestNativeGui } from './native-errors';
import { CSSVariableGenerator } from '@/lib/theme/cssGenerator';
import { getDefaultTheme } from '@/lib/theme/themes';

const bridge = (window as unknown as { __YURI_DESKTOP__: { guiPlugins: NativeGuiBridge } }).__YURI_DESKTOP__.guiPlugins;
const activation = await requestNativeGui(bridge, 'acquire', { id: 'pdf-fixture', revision: '1' }) as NativeGuiActivation;
const native = new NativeGuiSession(bridge, activation);
const host = new GuiPluginHost({
  client: {} as OpenCodeClient, files: {} as FilesAPI, queryClient: new QueryClient(),
  transport: 'fixture', storage: window.localStorage, locale: 'en', mode: 'dark', narrow: false,
});
host.install('pdf-fixture', activation.bundle, native);
await host.runCommand('pdf-fixture.export');
delete document.documentElement.dataset.pdf;
const titlebar = host.getSnapshot().titlebarItems[0];
if (!titlebar || host.getSnapshot().sessionKey) throw new Error('Global titlebar contribution missing');
await host.runTitlebarItem(titlebar.key);
if (!document.documentElement.dataset.pdf) throw new Error('Titlebar native IPC did not complete');
const status = host.getSnapshot().plugins[0];
if (status.error) throw new Error(status.error);
const catalog = host.appearanceCatalog.getSnapshot();
if (catalog.themes[0]?.metadata.name !== 'Ink' || !catalog.branding[0]?.logo?.dark.startsWith('data:image/svg+xml,')) throw new Error('Appearance catalog missing');
const generator = new CSSVariableGenerator();
for (const dark of [true, false]) {
  generator.apply(getDefaultTheme(dark));
  const background = getComputedStyle(document.documentElement).getPropertyValue('--surface-background').trim();
  if (background !== 'rgb(12, 34, 56)') throw new Error(`Plugin CSS precedence lost (${dark ? 'dark' : 'light'}: ${background})`);
}
if (activation.capabilities?.dockIcon) {
  const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
  const context = canvas.getContext('2d')!; context.fillStyle = '#123456'; context.fillRect(0, 0, 64, 64);
  await host.setDockIcon('pdf-fixture', canvas.toDataURL('image/png'));
  try {
    await host.setDockIcon('pdf-fixture', 'file:///not-an-icon.png');
    throw new Error('Invalid Dock image accepted');
  } catch (error) {
    if (!(error instanceof NativeGuiError) || error.code !== 'GUI_PLUGIN_INVALID_INPUT') throw error;
  }
}
host.dispose();
if (host.appearanceCatalog.getSnapshot().themes.length || document.head.querySelector('[data-yuri-plugin-style]')) throw new Error('Appearance cleanup failed');
// Policy failures must keep their code through the actual preload/contextBridge.
try {
  await requestNativeGui(bridge, 'call', { lease: 'foreign', ipc: 'pdf-fixture.export', method: 'pdf', request: 'denied' });
  throw new Error('Foreign lease unexpectedly accepted');
} catch (error) {
  if (!(error instanceof NativeGuiError) || error.code !== 'GUI_PLUGIN_LEASE_EXPIRED') throw error;
}
await requestNativeGui(bridge, 'window-only', {});
try {
  await requestNativeGui(bridge, 'acquire', { id: 'pdf-fixture', revision: '1' });
  throw new Error('Restricted document unexpectedly activated native code');
} catch (error) {
  if (!(error instanceof NativeGuiError) || error.code !== 'GUI_PLUGIN_DOCUMENT_RESTRICTED') throw error;
}
const remote = new GuiPluginHost({
  client: {} as OpenCodeClient, files: {} as FilesAPI, queryClient: new QueryClient(),
  transport: 'remote-fixture', storage: window.localStorage, locale: 'en', mode: 'dark', narrow: false,
});
remote.setSession({ id: 'remote-session', directory: '/workspace' });
remote.install('remote', { revision: '1', options: {}, code: `
  const {Plugin,Panel,Command,Ipc}=require('@opencode/plugin/gui');
  module.exports=Plugin.define({
    main(){throw new Error('Remote main must not execute')},
    setup(ctx){
      ctx.add(Panel,{id:'preview',region:'side',list:()=>[{id:'report',title:'Remote report'}],render:()=>{
        const view=document.createElement('div');view.textContent='Remote report preview';return view;
      }});
      ctx.add(Command,{id:'fallback',title:'fallback',run:async()=>{
        try{await ctx.main(Ipc.define({id:'remote.export',methods:{pdf:{}}})).pdf()}
        catch(error){document.documentElement.dataset.refusal=error.code}
      }});
    }
  });
` });
const container = document.createElement('div'); document.body.append(container);
remote.selectPanel('remote:report');
const unmount = remote.mountPanel('remote:report', container);
await remote.runCommand('remote.fallback');
if (container.textContent !== 'Remote report preview' || document.documentElement.dataset.refusal !== 'GUI_PLUGIN_UNSUPPORTED') {
  throw new Error('Window-only rendering or native error consumption failed');
}
unmount(); remote.dispose();
document.documentElement.dataset.finished = 'true';
