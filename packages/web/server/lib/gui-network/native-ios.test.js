import { expect, test, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import express from 'express';
import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware';
import { WebSocketServer } from 'ws';
import { createPrivateRelayServer } from '../../../../relay-server/src/index.js';
import { startRelayHost } from '../relay/host-client.js';
import { generateEcdhKeyPair, exportPublicKeyJwk } from '../relay/e2ee.js';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { createRequestSecurityRuntime } from '../security/request-security.js';
import { attachGuiNetwork } from './runtime.js';
import { createPreviewProxyRuntime } from '../preview/proxy-runtime.js';

const exec = promisify(execFile);
const device = process.env.YURI_IOS_TEST_DEVICE;
const products = process.env.YURI_IOS_TEST_PRODUCTS;
const cases = ['localhost', '127.0.0.1', '[::1]'].flatMap(targetHost => [
  { targetHost, prewarm: false, preview: false }, { targetHost, prewarm: true, preview: false },
  { targetHost, prewarm: true, preview: true },
]);
for (const { targetHost, prewarm, preview } of cases) {
test.skipIf(process.platform !== 'darwin' || !device || !products)(`real WKWebView routes ${targetHost} (prewarm=${prewarm}, preview=${preview}) through encrypted Relay and fails closed`, async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
  const work = await mkdtemp(join(tmpdir(), 'yuri-gui-network-'));
  const app = join(work, 'GuiNetworkProbe.app');
  const bundle = 'com.yuri.gui-network-regression';
  const simctl = (...args) => exec('xcrun', ['simctl', ...args], { encoding: 'utf8', timeout: 100000, maxBuffer: 4 * 1024 * 1024 });
  const relay = createPrivateRelayServer();
  const requests = [];
  const hostSockets = new Set();
  const connect = net.Socket.prototype.connect;
  const trackedConnect = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (...args) {
    this.once('connect', () => {
      const port = this.localPort;
      hostSockets.add(port);
      this.once('close', () => hostSockets.delete(port));
    });
    return connect.apply(this, args);
  });
  const origin = http.createServer(async (req, res) => {
    requests.push({ path: req.url, relayed: hostSockets.has(req.socket.remotePort) });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/disconnect') { res.end('bye'); setTimeout(() => host.stop(), 25); return; }
    if (req.url === '/upload') { let bytes = 0; for await (const chunk of req) bytes += chunk.length; res.end(String(bytes)); return; }
    res.setHeader('Content-Type', 'text/plain');
    if (req.url === '/frame') { res.setHeader('Content-Type', 'text/html'); res.end(`<head></head><iframe src="/nested"></iframe><script>onmessage=e=>{if(e.data==='nested-pass')parent.postMessage(e.data,'*')}</script>`); }
    else if (req.url === '/nested') { res.setHeader('Content-Type', 'text/html'); res.end(`<head></head><script src="/dynamic.js"></script>`); }
    else if (req.url === '/dynamic.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(`fetch('/resource').then(r=>r.text()).then(x=>parent.postMessage(x,'*'))`); }
    else res.end('nested-pass');
  });
  const echoes = new WebSocketServer({ server: origin });
  origin.on('upgrade', req => requests.push({ path: req.url, relayed: hostSockets.has(req.socket.remotePort) }));
  echoes.on('connection', socket => socket.on('message', data => socket.send(data.toString())));
  const pairedClient = { id: 'probe', authMethod: 'pairing', pairingId: 'probe-pairing', usesRelay: true };
  const auth = createUiAuth({ requireClientAuth: true, clientAuthController: { listClients: async () => [pairedClient], authenticateBearerToken: async token => token === 'probe-client'
    ? { ok: true, clientId: 'probe', sessionToken: 'client:probe', client: pairedClient } : { ok: false } } });
  const api = express(); api.post('/auth/url-token', auth.handleUrlAuthToken); api.use(auth.requireAuth);
  const server = http.createServer(api);
  const security = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) });
  const network = attachGuiNetwork({ server, uiAuthController: auth, isRequestOriginAllowed: security.isRequestOriginAllowed });
  if (preview) createPreviewProxyRuntime({ crypto, URL, createProxyMiddleware, responseInterceptor }).attach(api, {
    server, express, uiAuthController: auth, isRequestOriginAllowed: security.isRequestOriginAllowed,
    rejectWebSocketUpgrade: (socket, status) => socket.end(`HTTP/1.1 ${status} Rejected\r\n\r\n`),
  });
  let host;
  try {
    await relay.start();
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    origin.listen(0, targetHost === '[::1]' ? '::1' : '127.0.0.1'); await once(origin, 'listening');
    const enc = await generateEcdhKeyPair();
    const sign = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pub = sign.publicKey.export({ format: 'jwk' });
    const canonical = JSON.stringify({ crv: pub.crv, kty: pub.kty, x: pub.x, y: pub.y });
    const serverId = crypto.createHash('sha256').update(canonical).digest('base64url');
    const hostEncPubJwk = await exportPublicKeyJwk(enc.publicKey);
    const identity = { serverId, hostEncPubJwk, hostEncPrivateKey: enc.privateKey, signRelayAuth: (role, connectionId) => {
      const ts = Date.now();
      return { ts, pk: Buffer.from(canonical).toString('base64url'), sig: crypto.sign('SHA256', Buffer.from(`${ts}.${serverId}.${role}.${connectionId ?? ''}`), { key: sign.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url') };
    } };
    host = startRelayHost({ relayUrl: relay.wsUrl, identity, authorizeRequest: auth.authorizeRelayRequest, getLocalPort: () => server.address().port, onStatus() {}, logger: { warn() {}, info() {} } });
    await mkdir(join(app, 'Frameworks'), { recursive: true });
    for (const [directory, name] of [['Capacitor', 'Capacitor'], ['CapacitorCordova', 'Cordova']]) {
      await cp(join(products, directory, `${name}.framework`), join(app, 'Frameworks', `${name}.framework`), { recursive: true });
    }
    const sdk = (await exec('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path'])).stdout.trim();
    await exec('xcrun', ['--sdk', 'iphonesimulator', 'swiftc', '-sdk', sdk, '-target', 'arm64-apple-ios17.0-simulator',
      '-F', join(app, 'Frameworks'), '-framework', 'Capacitor', '-framework', 'Cordova', '-Xlinker', '-rpath', '-Xlinker', '@executable_path/Frameworks',
      join(root, 'packages/mobile/ios/App/App/YuriGuiNetworkPlugin.swift'), join(root, 'packages/mobile/test/gui-network-ios-probe.swift'), '-o', join(app, 'GuiNetworkProbe')]);
    await mkdir(join(app, 'public'));
    await exec('bun', [join(root, 'packages/mobile/test/gui-network-probe-build.mjs'), join(app, 'public')]);
    const config = { relayUrl: relay.wsUrl, serverId, hostEncPubJwk, target: `http://${targetHost}:${origin.address().port}`, prewarm, preview };
    await writeFile(join(app, 'public/index.html'), `<!doctype html><html><body><script>window.guiProbe=${JSON.stringify(config)}</script><script type="module" src="probe.js"></script></body></html>`);
    await writeFile(join(app, 'capacitor.config.json'), JSON.stringify({ appId: bundle, appName: 'GUI network probe', webDir: 'public', packageClassList: [] }));
    await writeFile(join(app, 'config.xml'), `<widget id="${bundle}" version="1.0.0"/>`);
    await writeFile(join(app, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundle}</string><key>CFBundleExecutable</key><string>GuiNetworkProbe</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>UILaunchScreen</key><dict/><key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict></dict></plist>`);
    await simctl('install', device, app);
    let output;
    try { output = (await simctl('launch', '--console', device, bundle)).stdout; }
    catch (error) { throw new Error(`probe failed: ${(error.stdout ?? '').split('\n').filter(line => line.includes('GUI_NETWORK_PROBE')).join('\n')}\n${error.stderr ?? ''}`); }
    const stages = output.split('\n').filter(line => line.includes('GUI_NETWORK_PROBE'));
    console.log(stages.join('\n'));
    expect.soft(requests.filter(request => !['/prewarm', '/after-release'].includes(request.path)), 'every active-lease request must originate at the Host TCP gateway').not.toEqual(expect.arrayContaining([expect.objectContaining({ relayed: false })]));
    expect(stages).toContain('GUI_NETWORK_PROBE PASSED');
    expect(requests.map(request => request.path)).toEqual(expect.arrayContaining(['/upload', '/echo', '/frame', '/nested', '/dynamic.js', '/resource']));
    expect(requests.map(request => request.path)).not.toContain('/after-disconnect');
    expect(requests).toContainEqual({ path: '/after-release', relayed: false });
  } finally {
    try { await simctl('uninstall', device, bundle); } catch { /* The probe may not have installed. */ }
    network.stop(); host?.stop(); await relay.stop(); auth.dispose();
    for (const client of echoes.clients) client.terminate(); echoes.close();
    server.closeAllConnections(); origin.closeAllConnections();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => origin.close(resolve))]);
    trackedConnect.mockRestore();
    await rm(work, { recursive: true, force: true });
  }
}, 180000);
}
