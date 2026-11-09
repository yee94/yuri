/// <reference path="../ui/src/types/desktop.d.ts" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../ui/src/lib/queryRuntime';
import { GuiPluginHost } from '../ui/src/lib/gui-plugins/host';
import { createGuiClient } from '../ui/src/lib/opencode/gui';
import { OpenCode } from '../ui/node_modules/@yuriai/opencode-gui-client/dist/promise/index.js';
import { createGuiPluginFetch } from './gui-plugin-transport';
import { createGuiPluginComposition } from './gui-plugin-composition';
import { captureGuiPluginFactory } from './gui-plugin-factory';
import { createGuiPluginChannel } from './gui-plugin-channel';
import { guiPreferencesKey } from '../ui/src/lib/gui-plugins/preferences';
import { createGuiPluginBrowser } from './gui-plugin-browser';
import type { GuiPluginPreviewState } from './gui-plugin-preview';

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(stop => stop()); document.body.replaceChildren(); });
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const code = `const G=require('@opencode/plugin/gui'), S=require('solid-js');
module.exports.default=G.Plugin.define({setup(ctx){
 const counts=globalThis.__nshGuiCounts; counts.setup++;
 S.onCleanup(()=>counts.dispose++);
 const pages=ctx.use(G.Contract.define('yuri.pages')); counts.pages=pages().status;
 ctx.add(G.Registry.define('yuri.page'),{id:'main',title:'Main',render(){throw Error('mobile must not mount page')}});
 ctx.add(G.Style,'.synthetic-preview { color: var(--foreground) }');
 ctx.add(G.LinkHandler,{match:l=>l.href.endsWith('.report.json'),open(l){ctx.layout.open(ctx.id+':'+l.href,ctx.sessions.current())}});
 ctx.add(G.Panel,{id:'report',region:'side',mobile:{title:'Reports',kind:'menu'},list:i=>i.open.map(p=>({id:p,title:p,file:p})),render(props){
  counts.render++; counts.options=G.usePlugin().options.value==='in-memory-synthetic-option';
  counts.root=props.screen.file.root; counts.path=props.tab.file;
  const n=document.createElement('input'); n.value='retained-local-state';
  const actions=ctx.use(G.Contract.define('yuri.previewActions'))();
  if(actions.status==='active') actions.value.register({element:n,capture:async()=>({html:'<p>synthetic</p>',width:100,height:100}),render(surface){
   const b=document.createElement('button'); b.textContent='synthetic action';
   surface.signal.addEventListener('abort',()=>counts.actionAborts++,{once:true}); return b;
  }});
  const path=props.tab.file; void props.screen.file.sync(path).catch(()=>{});
  S.createEffect(()=>{const state=props.screen.file.get(path); if(state?.loaded) counts.content=state.content.content});
  S.onCleanup(()=>{counts.unmount++; props.screen.file.unwatch(path)}); return n;
 }});
}});`;

function fixture(composed = false) {
  const counts = { setup: 0, dispose: 0, render: 0, unmount: 0, actionAborts: 0, pages: '', options: false, path: '', root: '', content: '' };
  Reflect.set(globalThis, '__nshGuiCounts', counts);
  const content = document.createElement('section'), actions = document.createElement('div');
  document.body.append(content, actions);
  let revision = 'one', current = true, enabled = true, inventoryError = false, bundleError = false;
  let ids = ['synthetic'];
  const states: GuiPluginPreviewState[] = [];
  const list = vi.fn(async (): Promise<unknown> => { if (inventoryError) throw Error('synthetic inventory failure'); return ids.map(id => ({ id, features: { gui: true }, state: { status: 'active' } })); });
  const gui = vi.fn(async () => { if (bundleError) throw Error('synthetic bundle failure'); return { code, revision, options: { value: 'in-memory-synthetic-option' } }; });
  const lifetime = new AbortController();
  const readFile = vi.fn(async (path: string) => ({ path, content: '{"synthetic":true}' }));
  const storage: Storage = { length: 0, clear() {}, getItem: () => null, key: () => null, removeItem() {}, setItem: vi.fn() };
  const options = {
    client: createGuiClient(lifetime.signal),
    files: { listDirectory: async () => ({ directory: '/work', entries: [] }), search: async () => [], createDirectory: async () => { throw Error('unsupported'); }, readFile },
    queryClient, storage, transport: 'synthetic-host', locale: 'en', mode: 'dark' as const,
  };
  const host = new GuiPluginHost({ ...options, narrow: true });
  const scope = { hostID: 'synthetic-host', lease: 'synthetic-scope-one' };
  const captureClient = vi.fn(expectedHost => { expect(expectedHost).toEqual(scope); expect(Object.isFrozen(expectedHost)).toBe(true); return { plugin: { list, gui } }; });
  const compositionDispose = vi.fn();
  const browserInput = { host, scope, appearance: { locale: 'en', mode: 'dark' as const }, captureClient, intent: { sessionId: 'session', directory: '/work', path: '/work/data.report.json' }, content, actions,
    enabled: () => enabled, isCurrent: () => current, changed: (state: GuiPluginPreviewState) => states.push(state) };
  const preview = composed ? createGuiPluginComposition({ ...browserInput, origin: 'https://synthetic.invalid',
    sender: { isCurrent: () => current, send: async () => { throw Error('Network forbidden in composition fixture'); } },
    capture: ({ expectedHost, signal }) => {
      expect(expectedHost).toEqual(scope); expect(signal.aborted).toBe(false);
      return { host, appearance: browserInput.appearance, enabled: browserInput.enabled, captureClient, themeCSS: ':root { --synthetic-theme-revision: one; }', dispose: compositionDispose };
    },
  }) : createGuiPluginBrowser(browserInput);
  cleanups.push(() => { lifetime.abort(); preview.close(); queryClient.clear(); Reflect.deleteProperty(globalThis, '__nshGuiCounts'); });
  return { preview, counts, content, actions, states, list, gui, readFile, storage, captureClient, compositionDispose,
    setRevision: (value: string) => { revision = value; }, setCurrent: (value: boolean) => { current = value; },
    setEnabled: (value: boolean) => { enabled = value; }, setIds: (value: string[]) => { ids = value; },
    failInventory: (value: boolean) => { inventoryError = value; }, failBundle: (value: boolean) => { bundleError = value; },
  };
}

describe('NSH prepared plugin content uses the actual official SDK and Solid host', () => {
  it.each([undefined, 'explicit-session'])('real file registry supports session=%s without a synthetic ID or suffix decision', async sessionId => {
    const observations: unknown[] = [];
    Reflect.set(globalThis, '__resourceRegistry', observations);
    const host = new GuiPluginHost({ client: createGuiClient(new AbortController().signal), files: { listDirectory: async () => ({ directory: '/work', entries: [] }), search: async () => [], createDirectory: async () => { throw Error('unsupported'); } },
      queryClient, storage: localStorage, transport: 'resources-registry', locale: 'en', mode: 'dark', narrow: true });
    const content = document.createElement('section'), actions = document.createElement('div');
    const states: GuiPluginPreviewState[] = [];
    const preview = createGuiPluginBrowser({ host, scope: { hostID: 'h', lease: 'l' }, appearance: { locale: 'en', mode: 'dark' },
      intent: { directory: '/work', path: '/work/registered.unknown', ...(sessionId === undefined ? {} : { sessionId }) }, content, actions, enabled: () => true, isCurrent: () => true,
      changed: state => states.push(state), captureClient: () => ({ plugin: {
        list: async () => [{ id: 'registry', features: { gui: true }, state: { status: 'active' } }],
        gui: async () => ({ revision: 'registry', options: {}, code: `const G=require('@opencode/plugin/gui');module.exports.default=G.Plugin.define({setup(ctx){
          ctx.add(G.LinkHandler,{match:l=>l.href.includes('registered.unknown'),open(l){globalThis.__resourceRegistry.push(l.session?.id??null);if(l.session)ctx.layout.open(ctx.id+':'+l.href,l.session)}});
          ctx.add(G.Panel,{id:'file',region:'side',list:i=>i.open.map(path=>({id:path,title:path,file:path})),render(){return document.createElement('article')}});
        }});` }),
      } }) });
    try {
      await preview.refresh(); await settle();
      expect(observations).toEqual([sessionId ?? null]);
      expect(states.at(-1)?.phase).toBe(sessionId === undefined ? 'unmatched' : 'mounted');
      expect(host.getSnapshot().sessionKey).toBe(sessionId === undefined ? undefined : `resources-registry\n${sessionId}`);
      expect(host.filePanel('/work/not-registered.eficy', '/work')).toBeUndefined();
    } finally { preview.close(); Reflect.deleteProperty(globalThis, '__resourceRegistry'); }
  });
  it.each(['buffered', 'stream'])('actual factory and %s channel distinguish empty existing files from missing files', async mode => {
    const scope = { hostID: 'optional-host', lease: 'optional-lease' };
    let existence: string | undefined = 'true', extra = false;
    const channel = createGuiPluginChannel({ scope, isCurrent: () => true, port: { async postMessage(input) {
      if (input.name === 'cancel') return true;
      if (input.name === 'chunk') return { done: true, base64: '' };
      if (input.name !== 'request') throw Error('Unexpected native fixture message');
      const headers = { ...(existence === undefined ? {} : { 'X-Yuri-File-Exists': existence }), ...(extra ? { 'set-cookie': 'synthetic-forbidden' } : {}) };
      return { status: 200, mime: 'text/plain; charset=utf-8', headers, ...(mode === 'stream' ? { stream: true } : { base64: '' }) };
    } } });
    const signal = new AbortController().signal;
    const fetch = createGuiPluginFetch({ scope, origin: 'https://synthetic.invalid', sender: channel.sender, signal });
    const factory = captureGuiPluginFactory({ expectedHost: scope, runtimeKey: 'optional-host', origin: 'https://synthetic.invalid', directory: '/work', fetch, signal,
      storage: localStorage, preferenceKey: guiPreferencesKey('optional-host'), appearance: { locale: 'en', mode: 'dark' }, themeCSS: ':root{}' });
    try {
      expect(await factory.files.readFile?.('/work/empty.txt', { optional: true })).toEqual({ path: '/work/empty.txt', content: '', exists: true });
      existence = 'false';
      expect(await factory.files.readFile?.('/work/missing.txt', { optional: true })).toEqual({ path: '/work/missing.txt', content: '', exists: false });
      existence = undefined;
      await expect(factory.files.readFile?.('/work/unknown.txt', { optional: true })).rejects.toThrow('GUI_INVALID_FILE_EXISTENCE');
      existence = 'true'; extra = true;
      await expect(factory.files.readFile?.('/work/extra.txt', { optional: true })).rejects.toThrow('GUI_PLUGIN_INVALID_RESPONSE_HEADERS');
    } finally { factory.host.dispose(); factory.dispose(); channel.close(); }
  });
  it('cancels a non-EOF optional read with missing existence metadata before opening another reader', async () => {
    const scope = { hostID: 'optional-reader-host', lease: 'optional-reader-lease' };
    const open = new Set<string>(), cancelled: string[] = [];
    let requestCount = 0;
    const channel = createGuiPluginChannel({ scope, isCurrent: () => true, port: { async postMessage(input) {
      const requestID = String(input.id);
      if (input.name === 'cancel') { cancelled.push(requestID); open.delete(requestID); return true; }
      if (input.name === 'chunk') return requestCount === 1 ? { done: false, base64: btoa('not EOF') } : { done: true, base64: '' };
      if (input.name !== 'request') throw Error('Unexpected native fixture message');
      if (open.size) throw Error('GUI reader slot is still occupied');
      requestCount++; open.add(requestID);
      return { status: 200, mime: 'text/plain; charset=utf-8', headers: requestCount === 1 ? {} : { 'x-yuri-file-exists': 'true' }, stream: true };
    } } });
    const signal = new AbortController().signal;
    const fetch = createGuiPluginFetch({ scope, origin: 'https://synthetic.invalid', sender: channel.sender, signal });
    const factory = captureGuiPluginFactory({ expectedHost: scope, runtimeKey: scope.hostID, origin: 'https://synthetic.invalid', directory: '/work', fetch, signal,
      storage: localStorage, preferenceKey: guiPreferencesKey(scope.hostID), appearance: { locale: 'en', mode: 'dark' }, themeCSS: ':root{}' });
    try {
      await expect(factory.files.readFile?.('/work/unknown.txt', { optional: true })).rejects.toThrow('GUI_INVALID_FILE_EXISTENCE');
      expect(cancelled).toEqual(['1']); expect(open.size).toBe(0);
      expect(await factory.files.readFile?.('/work/empty.txt', { optional: true })).toEqual({ path: '/work/empty.txt', content: '', exists: true });
    } finally { factory.host.dispose(); factory.dispose(); channel.close(); }
  });
  it('composition owns the genuine host mount, theme style and page lifetime without leaving CSS behind', async () => {
    const f = fixture(true); await f.preview.refresh(); await settle();
    expect(f.counts.render).toBe(1); expect(document.head.querySelector('[data-nsh-gui-theme]')?.textContent).toContain('--synthetic-theme-revision');
    f.preview.close(); f.preview.close();
    expect(f.compositionDispose).toHaveBeenCalledTimes(1); expect(f.counts.dispose).toBe(1);
    expect(document.head.querySelector('[data-nsh-gui-theme]')).toBeNull();
  });
  it('preserves actual official GUI GET and RPC POST requests through captured fetch', async () => {
    const scope = { hostID: 'synthetic', lease: 'original' };
    const requests: { route: string; method: string; body?: string }[] = [];
    const fetch = createGuiPluginFetch({ scope, origin: 'https://synthetic.invalid', signal: new AbortController().signal,
      sender: { isCurrent: expected => expected.lease === 'original', async send(expected, request) {
        expect(expected).toEqual(scope); requests.push(request);
         const payload = request.route === '/api/plugin' ? [] : request.route.startsWith('/api/plugin/gui') ? { code: '', revision: 'one', options: {} } : { data: { output: 'synthetic' } };
        return { status: 200, mime: 'application/json', base64: btoa(JSON.stringify(payload)) };
      } },
    });
    const client = OpenCode.make({ baseUrl: 'https://synthetic.invalid', fetch });
    expect(await client.plugin.list(undefined)).toEqual([]);
    expect(await client.plugin.gui({ id: 'synthetic-plugin' })).toEqual({ code: '', revision: 'one', options: {} });
    await client.rpc.call({ rpcID: 'synthetic.contract', method: 'read', input: { original: true } });
    expect(requests.map(request => [request.method, request.route])).toEqual([
      ['GET', '/api/plugin'], ['GET', '/api/plugin/gui?id=synthetic-plugin'], ['POST', '/api/rpc/synthetic.contract/read'],
    ]);
    expect(JSON.parse(requests[2].body ?? 'null')).toEqual({ input: { original: true } });
  });
  it('injects only own in-memory options; mounts custom complete suffix and keeps the owner on no-op refresh', async () => {
    const f = fixture(); await f.preview.refresh(); await settle();
    expect(f.counts).toMatchObject({ setup: 1, render: 1, options: true, pages: 'inactive', root: '/work', path: '/work/data.report.json', content: '{"synthetic":true}' });
    const node = f.content.firstChild;
    for (let i = 0; i < 50; i++) await f.preview.refresh();
    await settle();
    expect(f.content.firstChild).toBe(node); expect(f.counts.render).toBe(1);
    expect(f.captureClient).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.states)).not.toContain('in-memory-synthetic-option');
    expect(f.storage.setItem).not.toHaveBeenCalled();
    expect(document.head.querySelector('[data-yuri-plugin-style]')).not.toBeNull();
    expect(f.actions.children).toHaveLength(1);
    f.preview.close(); f.preview.close();
    expect(f.counts).toMatchObject({ dispose: 1, unmount: 1, actionAborts: 1 });
    expect(f.content.childNodes.length).toBe(0); expect(f.actions.childNodes.length).toBe(0);
    expect(document.head.querySelector('[data-yuri-plugin-style]')).toBeNull();
  });
  it('source transitions unmount actual context; replacement and authoritative disable release it', async () => {
    const f = fixture(); await f.preview.refresh(); await settle();
    f.preview.source(true); expect(f.counts.unmount).toBe(1); expect(f.states.at(-1)?.phase).toBe('source');
    await f.preview.refresh(); expect(f.states.at(-1)).toMatchObject({ phase: 'source', refreshing: false });
    f.preview.source(false); await settle(); expect(f.counts.render).toBe(2);
    f.setRevision('two'); await f.preview.refresh(); await settle();
    expect(f.counts).toMatchObject({ setup: 2, dispose: 1, render: 3, unmount: 2 });
    f.setEnabled(false); await f.preview.refresh(); await settle();
    expect(f.counts).toMatchObject({ dispose: 2, unmount: 3 });
    expect(f.states.at(-1)?.phase).toBe('unmatched');
  });
  it('preserves mounted state through inventory/bundle failure, then explicitly retries and accepts empty inventory', async () => {
    const f = fixture(); await f.preview.refresh(); await settle(); const node = f.content.firstChild;
    f.failInventory(true); await f.preview.refresh(); expect(f.content.firstChild).toBe(node);
    expect(f.states.at(-1)).toMatchObject({ phase: 'mounted', failure: 'inventory', refreshing: false });
    f.failInventory(false); f.failBundle(true); await f.preview.refresh(); expect(f.content.firstChild).toBe(node);
    expect(f.states.at(-1)?.failure).toBe('bundle');
    f.failBundle(false); await f.preview.refresh(); expect(f.states.at(-1)?.failure).toBeUndefined();
    f.setIds([]); await f.preview.refresh(); await settle(); expect(f.counts.dispose).toBe(1); expect(f.content.childNodes.length).toBe(0);
  });
  it('fences delayed bundle results and pagehide teardown without executing late plugin code', async () => {
    const f = fixture();
    let resolve!: (value: Awaited<ReturnType<typeof f.gui>>) => void;
    f.gui.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = f.preview.refresh(); await settle();
    f.setCurrent(false); f.preview.close(); resolve({ code, revision: 'late', options: { value: 'in-memory-synthetic-option' } });
    await pending; expect(f.counts.setup).toBe(0); expect(f.states.at(-1)?.phase).toBe('closed');
    const next = fixture(); await next.preview.refresh(); await settle();
    window.dispatchEvent(new Event('pagehide')); expect(next.counts.dispose).toBe(1); expect(next.states.at(-1)?.phase).toBe('closed');
  });
  it('rejects malformed inventory as invalid authority without deleting a live panel', async () => {
    const f = fixture(); await f.preview.refresh(); await settle(); const node = f.content.firstChild;
    f.list.mockResolvedValueOnce([{ features: { gui: true }, state: { status: 'active' } }]);
    await f.preview.refresh(); await settle();
    expect(f.content.firstChild).toBe(node); expect(f.counts.dispose).toBe(0);
    expect(f.states.at(-1)).toMatchObject({ phase: 'mounted', failure: 'invalid-inventory' });
  });
  it('isolates two mounted instances and does not let one failed setup block another plugin', async () => {
    const first = fixture(); await first.preview.refresh(); await settle();
    const second = fixture(); await second.preview.refresh(); await settle();
    expect(first.content.firstChild).not.toBe(second.content.firstChild);
    first.preview.source(true); expect(first.counts.unmount).toBe(1); expect(second.counts.unmount).toBe(0);
    second.preview.close(); expect(second.counts.dispose).toBe(1); expect(first.counts.dispose).toBe(0);
    const partial = fixture(); partial.setIds(['failed', 'working']);
    partial.gui.mockResolvedValueOnce({ code: 'throw Error("synthetic setup failure")', revision: 'bad', options: { value: 'in-memory-synthetic-option' } });
    await partial.preview.refresh(); await settle();
    expect(partial.states.at(-1)?.phase).toBe('mounted'); expect(partial.counts.render).toBe(1);
  });
});
