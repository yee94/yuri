import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const artifact = path.join(root, '.nsh/gui-plugin-preview');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
let close: (() => void) | undefined;
beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Direct network forbidden in artifact fixture'); }); });
afterEach(() => { close?.(); close = undefined; document.body.replaceChildren(); Reflect.deleteProperty(globalThis, '__guiArtifact'); vi.restoreAllMocks(); });
beforeAll(() => {
  const result = spawnSync('node', ['packages/nsh/scripts/build-gui-plugin-preview.mjs'], { cwd: path.resolve(root, '../..'), encoding: 'utf8', timeout: 60_000 });
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const code = `const G=require('@opencode/plugin/gui'), S=require('solid-js'), E=require('effect');
module.exports.default=G.Plugin.define({setup(ctx){
 const counts=globalThis.__guiArtifact;
 counts.setup++;
 const store=ctx.storage.store('count',{schema:E.Schema.Struct({count:E.Schema.Number}),initial:{count:0}});
 store.set({count:store.value.count+1}); counts.persisted=store.value.count;
 S.onCleanup(()=>counts.cleanup++);
 ctx.add(G.LinkHandler,{match:l=>l.href.endsWith('.report.json'),open(l){ctx.layout.open(ctx.id+':'+l.href,ctx.sessions.current())}});
 ctx.add(G.Panel,{id:'report',region:'side',mobile:{title:'Reports',kind:'menu'},list:i=>i.open.map(p=>({id:p,title:p,file:p})),render(props){
  counts.render++; counts.options=G.usePlugin().options.message==='synthetic-in-memory';
  const node=document.createElement('output');
  S.createEffect(()=>{const file=props.screen.file.get(props.tab.file); if(file?.loaded)node.textContent=file.content.content});
  void props.screen.file.sync(props.tab.file).catch(()=>{});
  void props.screen.file.search('report').then(rows=>counts.search=rows[0]);
  void ctx.client.rpc.call({rpcID:'synthetic.contract',method:'read',input:{exact:true}}).then(()=>counts.rpc++);
  S.onCleanup(()=>counts.unmount++); return node;
 }});
}});`;

async function launch(disabled: boolean, failStorage = false) {
  const exports: unknown = new Function(readFileSync(path.join(artifact, 'assets/entry.js'), 'utf8') + ';return YuriGuiPluginPreview;')();
  if (!record(exports) || typeof exports.startGuiPluginPreview !== 'function') throw Error('Missing actual entry');
  const root = document.createElement('main'); root.id = 'gui-plugin-root'; document.body.append(root);
  const scope = { hostID: 'synthetic-device', lease: 'synthetic-lease' };
  const preferenceKey = 'yuri.inst.c3ludGhldGljLWRldmljZQ.gui-plugins.disabled';
  const storage = new Map<string, string>([[preferenceKey, JSON.stringify(disabled ? ['synthetic-plugin'] : [])]]);
  const calls: { method: string; route: string; body?: string }[] = [];
  const states: unknown[] = [];
  const counts = { setup: 0, persisted: 0, cleanup: 0, render: 0, unmount: 0, options: false, rpc: 0, search: '' };
  Reflect.set(globalThis, '__guiArtifact', counts);
  const result: unknown = await exports.startGuiPluginPreview({ window,
    port: { async postMessage(input: Record<string, unknown>) {
      if (input.name === 'bootstrap') return { runtimeKey: 'synthetic-device', preferenceKey, locale: 'en', mode: 'dark', themeCSS: ':root { --foreground: rgb(222,222,222); }',
        labels: { loading: 'Synthetic loading', failed: 'Synthetic error', retry: 'Synthetic retry', source: 'Synthetic source', preview: 'Synthetic preview' },
        intent: { expectedHost: scope, sessionId: 's', directory: '/work', path: '/work/a.report.json' } };
      expect(input.expectedHost).toEqual(scope);
      if (input.name === 'state') { states.push(input.phase); return true; }
      if (input.name === 'cancel') return true;
      if (input.name !== 'request' || !record(input.input) || typeof input.input.route !== 'string' || typeof input.input.method !== 'string') throw Error('Invalid native fixture request');
      const request = input.input; calls.push({ method: input.input.method, route: input.input.route, ...(typeof request.body === 'string' ? { body: request.body } : {}) });
      const url = new URL(input.input.route, 'https://synthetic.invalid');
      if (url.pathname === '/api/fs/stat' || url.pathname === '/api/fs/read') {
        if (!record(request.headers)) throw Error('Missing actual file scope headers');
        expect(request.headers['x-opencode-directory']).toBe('/work');
      }
      let data: unknown;
      let mime = 'application/json';
      if (url.pathname === '/api/plugin') data = { data: [{ id: 'synthetic-plugin', features: { gui: true }, state: { status: 'active' } }] };
      else if (url.pathname === '/api/plugin/gui') data = { data: { code, revision: 'one', options: { message: 'synthetic-in-memory' } } };
      else if (url.pathname === '/api/fs/stat') data = { isFile: true, size: 15, mtimeMs: 1 };
      else if (url.pathname === '/api/fs/read') { data = 'synthetic file'; mime = 'text/plain; charset=utf-8'; }
      else if (url.pathname === '/api/fs/find') data = { location: { directory: '/work' }, data: [{ path: 'a.report.json', type: 'file' }] };
      else if (url.pathname === '/api/rpc/synthetic.contract/read') data = { data: { output: true } };
      else throw Error('Unexpected fixture route ' + url.pathname);
      return { status: 200, mime, base64: btoa(typeof data === 'string' ? data : JSON.stringify(data)) };
    } },
    storagePrompt(name: string, text: string) {
      expect(name).toBe('yuri.gui.storage.v1');
      const input: unknown = JSON.parse(text);
      if (!record(input) || !record(input.operation)) throw Error('Bad storage request');
      expect(input.expectedHost).toEqual(scope);
      const op = input.operation;
      if (op.method === 'get' && typeof op.key === 'string') return JSON.stringify({ ok: true, value: storage.get(op.key) ?? null });
      if (op.method === 'set' && typeof op.key === 'string' && typeof op.value === 'string') {
        if (failStorage) return '{"ok":false}';
        storage.set(op.key, op.value); return '{"ok":true,"value":true}';
      }
      throw Error('Unexpected synthetic storage operation');
    },
  });
  if (!record(result) || typeof result.close !== 'function') throw Error('Missing production close');
  const stop = result.close; close = () => stop();
  await settle();
  return { root, storage, calls, counts, states };
}

describe('actual offline GUI browser artifact', () => {
  it('ships real SDK/host and a checked index/assets manifest, without the main Web app', () => {
    const manifest: unknown = JSON.parse(readFileSync(path.join(artifact, 'manifest.json'), 'utf8'));
    if (!record(manifest) || !record(manifest.assets)) throw Error('Bad generated manifest');
    expect(manifest.entry).toBe('/index.html');
    for (const [file, value] of Object.entries(manifest.assets)) {
      if (!record(value)) throw Error('Bad asset entry');
      const bytes = readFileSync(path.join(artifact, file.slice(1)));
      expect(value.bytes).toBe(bytes.length); expect(value.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
    expect(readFileSync(path.join(artifact, 'index.html'), 'utf8')).toContain('startGuiPluginPreview');
    expect(readFileSync(path.join(artifact, 'index.html'), 'utf8')).not.toContain('eficy');
  });
  it('runs the emitted host with SDK/file/RPC/native storage and preserves source transitions', async () => {
    const f = await launch(false);
    expect(f.counts).toMatchObject({ setup: 1, persisted: 1, render: 1, options: true, rpc: 1, search: 'a.report.json' });
    expect(f.root.querySelector('output')?.textContent).toBe('synthetic file');
    expect([...f.storage.values()].join(' ')).not.toContain('synthetic-in-memory');
    expect(f.calls.some(call => call.route === '/api/plugin/gui?id=synthetic-plugin')).toBe(true);
    expect(f.calls.find(call => call.route === '/api/rpc/synthetic.contract/read')?.body).toBe('{"input":{"exact":true}}');
    const toggle = [...f.root.querySelectorAll('button')].find(button => button.textContent === 'Synthetic source');
    toggle?.click(); await settle(); expect(f.counts.unmount).toBe(1);
    expect(f.root.querySelector('pre')?.textContent).toBe('synthetic file');
    toggle?.click(); await settle(); expect(f.counts.render).toBe(2);
    close?.(); expect(f.counts.cleanup).toBe(1); expect(f.counts.unmount).toBe(2);
  });
  it('uses real disabled preferences before downloading code and does not adopt failed persistent writes', async () => {
    const disabled = await launch(true);
    expect(disabled.counts.setup).toBe(0); expect(disabled.calls.some(call => call.route.startsWith('/api/plugin/gui'))).toBe(false);
    close?.(); close = undefined;
    const failed = await launch(false, true);
    expect(failed.counts.render).toBe(0); expect(failed.states).toContain('error');
    expect([...failed.storage.keys()].some(key => key.startsWith('yuri.gui-plugin.'))).toBe(false);
  });
});
