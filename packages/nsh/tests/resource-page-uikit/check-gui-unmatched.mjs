import { Window } from 'happy-dom';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Run the exact production browser bundle with a synthetic native message port.
// This is a DOM/SDK contract, not NSH, UIKit, WebKit, network or device evidence.
const [assetDirectory, reportPath] = process.argv.slice(2);
if (!assetDirectory || !reportPath) throw Error('Usage: check-gui-unmatched.mjs <adapter-directory> <new-report-path>');
const source = await readFile(path.join(assetDirectory, 'assets/entry.js'), 'utf8');
const window = new Window({ url: 'https://synthetic.invalid/index.html' });
window.document.body.innerHTML = '<main id="gui-plugin-root"></main>';
const scope = { hostID: 'synthetic-resource-page', lease: '00000000-0000-4000-8000-000000000001' };
const runtimeKey = 'nsh:' + scope.hostID, phases = [], requests = [];
let unexpected = 0, failure;
const port = {
  async postMessage(input) {
    if (input.name === 'bootstrap') return {
      intent: { directory: '/fixture', path: '/fixture/index.html', expectedHost: scope, owner: 'offline' },
      runtimeKey, preferenceKey: 'yuri.inst.' + Buffer.from(runtimeKey).toString('base64url') + '.gui-plugins.disabled',
      locale: 'en', mode: 'light', themeCSS: ':root{--background:white}',
      labels: { loading: 'Loading', failed: 'Failed', retry: 'Retry', source: 'Source', preview: 'Preview' },
    };
    if (input.name === 'state') { phases.push(input.phase); return true; }
    if (input.name === 'cancel') return true;
    if (input.name === 'request') {
      requests.push(input.input);
      if (JSON.stringify(input.expectedHost) === JSON.stringify(scope) && input.input.method === 'GET' && input.input.route === '/api/plugin' && input.input.body === undefined) {
        // The authoritative Host inventory is a raw JSON array, not an SDK envelope.
        return { status: 200, mime: 'application/json', headers: {}, base64: Buffer.from('[]').toString('base64') };
      }
    }
    unexpected++; throw Error('unmapped synthetic GUI operation');
  },
};
try {
  const api = window.eval(source + ';YuriGuiPluginPreview');
  const owner = await api.startGuiPluginPreview({ window, port, storagePrompt(name, text) {
    const value = JSON.parse(text);
    if (name !== 'yuri.gui.storage.v1' || value.operation?.method !== 'get' || value.operation.key !== 'yuri.inst.' + Buffer.from(runtimeKey).toString('base64url') + '.gui-plugins.disabled') { unexpected++; throw Error('unmapped synthetic GUI storage'); }
    return JSON.stringify({ ok: true, value: null });
  } });
  owner.close();
} catch (error) { failure = error instanceof Error ? error.message : String(error); }
finally { await window.happyDOM.close(); }
const accepted = phases.includes('unmatched') && !phases.includes('error') && requests.length === 1 && unexpected === 0 && !failure;
const report = { syntheticOnly: true, kind: 'production-bundle-DOM-SDK-contract', engineStarted: false, network: false, uikitProved: false,
  adapterSHA256: createHash('sha256').update(source).digest('hex'), inventoryJSON: '[]', phases, requests, unexpected, ...(failure ? { failure } : {}), accepted };
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
if (!accepted) process.exitCode = 1;
