#!/usr/bin/env node
import { build } from 'vite';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length > 2 || (args.length && (args[0] !== '--out' || !args[1]))) throw new Error('Usage: node packages/nsh/scripts/build-gui-plugin-preview.mjs [--out directory]');
const output = path.resolve(args[1] ?? path.join(packageRoot, '.nsh/gui-plugin-preview'));
await mkdir(output, { recursive: true });
// Existing local dependencies only; never invokes npm, package install or NSH.
await build({
  configFile: false,
  root: packageRoot,
  resolve: { alias: { '@': path.resolve(packageRoot, '../ui/src') }, conditions: ['browser'], dedupe: ['solid-js', 'react', 'react-dom'] },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  plugins: [{
    name: 'nsh-gui-content-only',
    generateBundle() {
      const forbidden = [
        '../ui/src/App.tsx', '../ui/src/main.tsx', '../ui/src/components/MobileApp.tsx',
        '../web/src/main.tsx', 'App.tsx', 'application.tsx', 'runtime.ts', 'state.ts',
      ].map(file => path.resolve(packageRoot, file));
      for (const id of this.getModuleIds()) if (forbidden.includes(id.split('?', 1)[0])) throw new Error('Main application entered GUI content bundle');
    },
  }],
  build: {
    outDir: output, emptyOutDir: false, minify: true, sourcemap: false,
    lib: { entry: path.join(packageRoot, 'gui-plugin-entry.ts'), name: 'YuriGuiPluginPreview', formats: ['iife'], fileName: () => 'assets/entry.js' },
    rollupOptions: { output: { assetFileNames: 'assets/[name][extname]' } },
  },
});
const css = `html,body,#gui-plugin-root{height:100%;margin:0;min-width:0}body{background:var(--background);color:var(--foreground);font-family:var(--font-sans,system-ui)}#gui-plugin-root{display:flex;flex-direction:column}.gui-toolbar,.gui-actions{display:flex;align-items:center;gap:.5rem}.gui-toolbar{padding:.5rem}.gui-actions{margin-inline-end:auto}.gui-content{flex:1;min-height:0;overflow:auto}.gui-source{flex:1;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--font-mono,monospace)}#gui-plugin-root>.gui-content[hidden],#gui-plugin-root>.gui-source[hidden],#gui-plugin-root>.gui-toolbar>button[hidden]{display:none!important}#gui-plugin-root>.gui-toolbar>button{font:inherit;color:var(--foreground);background:var(--surface-muted);border:0;border-radius:var(--radius);padding:.5rem;min-height:36px;min-width:36px}#gui-plugin-root>.gui-status:empty{display:none}`;
await writeFile(path.join(output, 'assets/surface.css'), css);
// A real application entry invokes the actual host factory; no report/plugin data.
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/surface.css"></head><body><main id="gui-plugin-root"></main><script src="/assets/entry.js"></script><script>YuriGuiPluginPreview.startGuiPluginPreview({window:window,port:YuriGuiPluginPreview.nativeGuiPluginPort(window),storagePrompt:function(name,input){return window.prompt(name,input)}}).catch(function(){window.webkit.messageHandlers.guiPluginPreview.postMessage({name:'intent'}).then(function(intent){return window.webkit.messageHandlers.guiPluginPreview.postMessage({name:'state',expectedHost:intent.expectedHost,phase:'error'})}).catch(function(){})})</script></body></html>`;
await writeFile(path.join(output, 'index.html'), html);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const assets = {};
async function enumerate(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) { await enumerate(file); continue; }
    const name = '/' + path.relative(output, file).split(path.sep).join('/');
    if (name === '/manifest.json') continue;
    if (!entry.isFile() || !(name === '/index.html' || name.startsWith('/assets/'))) throw new Error('Unexpected staged asset: ' + name);
    const contentType = mime[path.extname(name)];
    if (!contentType) throw new Error('Missing asset MIME: ' + name);
    const bytes = await readFile(file), info = await stat(file);
    if (info.size > 8 * 1024 * 1024) throw new Error('Asset exceeds native limit: ' + name);
    assets[name] = { mime: contentType, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
}
await enumerate(output);
if (Object.values(assets).reduce((sum, asset) => sum + asset.bytes, 0) > 32 * 1024 * 1024) throw new Error('Assets exceed native total limit');
await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ version: 1, entry: '/index.html', assets }, null, 2) + '\n');
console.log('GUI preview staged: ' + output);
