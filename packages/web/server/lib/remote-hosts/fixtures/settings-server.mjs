import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const config = await new Promise(resolve => process.once('message', resolve));
for (const key of Object.keys(process.env)) if (/^(YURI_|OPENCODE_)/.test(key)) delete process.env[key];
Object.assign(process.env, { HOME: config.root, XDG_CONFIG_HOME: path.join(config.root, 'config'),
  XDG_DATA_HOME: path.join(config.root, 'data'), XDG_STATE_HOME: path.join(config.root, 'state'),
  YURI_DATA_DIR: path.join(config.root, 'hub'), YURI_RUNTIME: 'desktop', NODE_ENV: 'development',
  YURI_SKIP_OPENCODE_START: 'true', OPENCODE_HOST: config.upstream,
  YURI_WEIXIN_ENABLED: '0', YURI_CHANNELS_ENABLED: '0' });
const { createRemoteClientAuthRuntime } = await import('../../client-auth/remote-clients.js');
const clients = createRemoteClientAuthRuntime({ fsPromises: fs, path, crypto,
  storePath: path.join(config.root, 'hub', 'remote-clients.json') });
const credentials = [];
credentials.push(await clients.createClient({ clientKind: 'desktop-local' }));
credentials.push(await clients.createClient({ clientKind: 'mobile', authMethod: 'pairing', pairingId: 'fixture-pairing' }));
const { startWebUiServer } = await import('../../../index.js');
const hub = await startWebUiServer({ port: 0, host: '127.0.0.1', apiOnly: true,
  attachSignals: false, exitOnShutdown: false, remoteHostsAdapter: { listHosts: async () => config.hosts } });
process.send({ origin: `http://127.0.0.1:${hub.getPort()}`, tokens: credentials.map(c => c.token) });
process.on('message', async message => {
  if (message !== 'stop') return;
  await hub.stop({ exitProcess: false, forceCloseConnections: true });
  process.exit(0);
});
