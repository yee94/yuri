import { randomUUID } from 'node:crypto';
import { createBrowserSocksGateway } from './browser-socks-gateway.mjs';

const PREFIX = 'yuri-browser-relay-';
const EVENT = 'yuri:browser-relay:data';

/** Per-view in-memory sessions; neither the application session nor other windows
 * ever inherit this SOCKS proxy. Main holds no Relay credentials or target TLS.
 */
export function registerBrowserRelayNetwork({ app, ipcMain, session, authorize }) {
  const leases = new Map();
  const owners = new WeakSet();
  const dispose = (lease) => {
    if (leases.get(lease.scope) !== lease) return;
    leases.delete(lease.scope);
    for (const guest of lease.guests) if (!guest.isDestroyed()) guest.close();
    void lease.gateway.close();
    void lease.session.closeAllConnections().catch(() => {});
    // Keep the dead SOCKS proxy configured. A stale guest must fail closed,
    // never revert to direct access to this computer's localhost.
  };
  const releaseOwner = (owner) => {
    for (const lease of leases.values()) if (lease.owner === owner) dispose(lease);
  };
  const watchOwner = (owner) => {
    if (owners.has(owner)) return;
    owners.add(owner);
    owner.once('destroyed', () => releaseOwner(owner));
    owner.on('render-process-gone', () => releaseOwner(owner));
    owner.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) releaseOwner(owner);
    });
    owner.on('will-attach-webview', (event, preferences, params) => {
      if (!String(params.partition ?? '').startsWith(PREFIX)) return;
      const lease = [...leases.values()].find(item => item.partition === params.partition && item.owner === owner && item.ready);
      if (!lease) { event.preventDefault(); return; }
      delete preferences.preload;
      delete preferences.preloadURL;
      Object.assign(preferences, { nodeIntegration: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, webSecurity: true });
    });
    owner.on('did-attach-webview', (_event, guest) => {
      const lease = [...leases.values()].find(item => item.owner === owner && item.session === guest.session);
      if (!lease) return;
      lease.guests.add(guest);
      guest.once('destroyed', () => lease.guests.delete(guest));
    });
  };
  const own = (event, scope) => {
    authorize(event, 'browser-relay');
    const lease = leases.get(scope);
    if (!lease || lease.owner !== event.sender) throw new Error('Browser Relay owner mismatch');
    return lease;
  };
  app.on('web-contents-created', (_event, owner) => watchOwner(owner));
  ipcMain.handle('yuri:browser-relay:start', async (event) => {
    authorize(event, 'browser-relay:start');
    const owner = event.sender;
    if ([...leases.values()].filter(item => item.owner === owner).length >= 8) throw new Error('Browser Relay limit');
    watchOwner(owner);
    const scope = randomUUID();
    const partition = `${PREFIX}${scope}`;
    const browserSession = session.fromPartition(partition, { cache: false });
    const gateway = createBrowserSocksGateway({
      send(value) {
        if (owner.isDestroyed() || !leases.has(scope)) return false;
        owner.send(EVENT, { scope, data: typeof value === 'object' && !Buffer.isBuffer(value) ? JSON.stringify(value) : value });
        return true;
      },
    });
    const lease = { scope, partition, owner, session: browserSession, gateway, guests: new Set(), ready: false };
    leases.set(scope, lease);
    try {
      const { port } = await gateway.start();
      await browserSession.setProxy({
        mode: 'fixed_servers', proxyRules: `socks5://127.0.0.1:${port}`,
        proxyBypassRules: '<-loopback>',
      });
      await browserSession.closeAllConnections();
      if (owner.isDestroyed() || leases.get(scope) !== lease) throw new Error('Browser Relay ended');
      lease.ready = true;
      return { scope, partition };
    } catch (error) { dispose(lease); throw error; }
  });
  ipcMain.handle('yuri:browser-relay:write', (event, { scope, data } = {}) => {
    const lease = own(event, scope);
    try { lease.gateway.receive(data); }
    catch (error) { dispose(lease); throw error; }
  });
  ipcMain.handle('yuri:browser-relay:stop', (event, { scope } = {}) => {
    dispose(own(event, scope));
  });
  app.once('will-quit', () => { for (const lease of [...leases.values()]) dispose(lease); });
}
