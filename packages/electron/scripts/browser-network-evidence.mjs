import { app, BrowserWindow, ipcMain, protocol, session } from 'electron';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { registerBrowserRelayNetwork } from '../browser-relay-network.mjs';
import { attachGuiNetwork } from '../../web/server/lib/gui-network/runtime.js';
import { createUiAuth } from '../../web/server/lib/ui-auth/ui-auth.js';
import { createRemoteClientAuthRuntime } from '../../web/server/lib/client-auth/remote-clients.js';
import { createRequestSecurityRuntime } from '../../web/server/lib/security/request-security.js';

const require = createRequire(new URL('../../web/package.json', import.meta.url));
const express = require('express');
const { WebSocketServer } = require('ws');
const root = process.env.YURI_BROWSER_EVIDENCE_ROOT;
const mode = process.env.YURI_BROWSER_EVIDENCE_MODE;
app.setPath('userData', path.join(root, 'profile'));
protocol.registerSchemesAsPrivileged([{ scheme: 'yuri-ui', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const servers = [], connections = new Set();
const listen = async server => {
  servers.push(server);
  server.on('connection', socket => { connections.add(socket); socket.once('close', () => connections.delete(socket)); });
  server.listen(0, '::'); await once(server, 'listening'); return server.address().port;
};
let owner, network, auth;
async function main() {
try {
  await app.whenReady();
  const clients = createRemoteClientAuthRuntime({ fsPromises: fs, path, crypto, storePath: path.join(root, 'clients.json') });
  const client = await clients.createClient({ clientKind: 'desktop', authMethod: 'pairing', pairingId: 'test' });
  auth = createUiAuth({ password: null, clientAuthController: clients, readSettingsFromDiskMigrated: async () => ({}) });
  const security = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) });
  const api = express();
  api.post('/auth/url-token', auth.handleUrlAuthToken);
  const apiServer = http.createServer(api);
  network = attachGuiNetwork({ server: apiServer, uiAuthController: auth, isRequestOriginAllowed: security.isRequestOriginAllowed });
  const apiPort = await listen(apiServer);
  const tokenResponse = await fetch(`http://127.0.0.1:${apiPort}/auth/url-token`, { method: 'POST', headers: { Authorization: `Bearer ${client.token}` } });
  const { token } = await tokenResponse.json();
  const requests = [];
  const targetPort = await listen(http.createServer((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization });
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/upload') {
      let size = 0; req.on('data', bytes => { size += bytes.length; }); req.on('end', () => res.end(String(size))); return;
    }
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Host website</title><body>Host website</body>');
  }));
  const wsServer = http.createServer();
  const wsPort = await listen(wsServer);
  const wss = new WebSocketServer({ server: wsServer });
  wss.on('connection', socket => socket.on('message', (bytes, binary) => socket.send(bytes, { binary })));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem')], { stdio: 'ignore' });
  const tlsPort = await listen(https.createServer({
    key: await fs.readFile(path.join(root, 'key.pem')), cert: await fs.readFile(path.join(root, 'cert.pem')),
  }, (_req, res) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.end('tls-through-host'); }));
  const html = '<!doctype html><body></body>';
  api.get('/session/test', (_req, res) => res.type('html').send(html));
  const localOrigin = `http://127.0.0.1:${apiPort}`;
  const uiUrl = mode === 'bundled' ? 'yuri-ui://app/session/test' : `${localOrigin}/session/test`;
  protocol.handle('yuri-ui', () => new Response(html, { headers: { 'Content-Type': 'text/html' } }));
  ipcMain.on('yuri:window-runtime', event => { event.returnValue = { localOrigin, apiBaseUrl: localOrigin }; });
  registerBrowserRelayNetwork({ app, ipcMain, session, authorize(event) {
    assert.equal(event.sender, owner.webContents);
    assert.equal(event.senderFrame, owner.webContents.mainFrame);
    assert.equal(event.senderFrame.url, uiUrl);
  } });
  owner = new BrowserWindow({ show: false, webPreferences: {
    webviewTag: true, contextIsolation: true, sandbox: false,
    preload: fileURLToPath(new URL('../preload.mjs', import.meta.url)),
    additionalArguments: [`--yuri-local-origin=${localOrigin}`, `--yuri-packaged=${mode === 'bundled' ? 1 : 0}`],
  } });
  await owner.loadURL(uiUrl);
  const run = code => owner.webContents.executeJavaScript(code);
  const descriptor = await run(`(async () => {
    const bridge = window.__YURI_DESKTOP__.browserRelay;
    const socket = new WebSocket(${JSON.stringify(`ws://127.0.0.1:${apiPort}/api/gui-network/ws?yuri_url_token=${token}`)});
    socket.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => { socket.onmessage = e => JSON.parse(e.data).type === 'ready' ? resolve() : reject(); socket.onerror = reject; });
    const lease = await bridge.start();
    const unsubscribe = bridge.subscribe(e => { if (e.scope === lease.scope) socket.send(e.data); });
    socket.onmessage = e => bridge.write(lease.scope, typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
    window.endNetwork = async () => { unsubscribe(); socket.close(); await bridge.stop(lease.scope); };
    return lease;
  })()`);
  const browserSession = session.fromPartition(descriptor.partition);
  browserSession.setCertificateVerifyProc((_request, callback) => callback(0));
  assert.match(await browserSession.resolveProxy(`http://127.0.0.1:${targetPort}`), /^SOCKS5 /);
  assert.equal(await owner.webContents.session.resolveProxy(`http://127.0.0.1:${targetPort}`), 'DIRECT');
  for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
    const result = await run(`(async () => {
      document.querySelector('webview')?.remove();
      const view = document.createElement('webview');
      view.setAttribute('partition', ${JSON.stringify(descriptor.partition)});
      view.setAttribute('src', ${JSON.stringify(`http://${hostname}:${targetPort}/`)});
      const ready = new Promise((resolve, reject) => { view.addEventListener('dom-ready', resolve, {once:true}); view.addEventListener('did-fail-load', e => reject(new Error(e.errorDescription)), {once:true}); });
      document.body.append(view); await ready;
      return view.executeJavaScript(${JSON.stringify(`(async () => {
        const uploaded = await (await fetch('/upload', { method:'POST', body:new Uint8Array(256 * 1024) })).text();
        const echoed = await new Promise((resolve,reject) => {
          const ws = new WebSocket('ws://${hostname}:${wsPort}/');
          ws.onopen = () => ws.send('cross-port');
          ws.onmessage = e => { resolve(e.data); ws.close(); }; ws.onerror = reject;
        });
        const tls = await (await fetch('https://localhost:${tlsPort}/')).text();
        return { uploaded, echoed, tls, privileged: !!window.__YURI_DESKTOP__ };
      })()`)});
    })()`);
    assert.deepEqual(result, { uploaded: String(256 * 1024), echoed: 'cross-port', tls: 'tls-through-host', privileged: false });
  }
  assert.equal(requests.some(req => req.authorization), false);
  await run('window.endNetwork()');
  const count = requests.length;
  await assert.rejects(browserSession.fetch(`http://127.0.0.1:${targetPort}/after-release`));
  assert.equal(requests.length, count);
  assert.equal((await owner.webContents.session.fetch(`http://127.0.0.1:${targetPort}/application-direct`)).status, 200);
  console.log(JSON.stringify({ mode, http: true, upload: true, crossPortWS: true, https: true, loopback: ['localhost', 'IPv4', 'IPv6'], failClosed: true, appDirect: true }));
  owner.destroy();
  network.stop(); auth.dispose();
  for (const socket of connections) socket.destroy();
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  app.exit(0);
} catch (error) {
  console.error(error);
  owner?.destroy(); network?.stop(); auth?.dispose();
  for (const socket of connections) socket.destroy();
  app.exit(1);
}
}
void main();
