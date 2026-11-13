// Real Yuri Hub in Electron's Node ABI; no proxy/fake server implementation.
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { startSeededOpenCode } from './seeded-opencode.mjs';

const config = JSON.parse(fs.readFileSync(process.env.REMOTE_PROJECTS_IOS_HUB_CONFIG, 'utf8'));
app.setPath('appData', path.join(config.root, 'app-data'));
app.setPath('userData', path.join(config.root, 'user-data'));
app.setPath('logs', path.join(config.root, 'logs'));
let service, hub;
let stopping = false;
const stop = async (exitCode = 0) => {
  if (stopping) return;
  stopping = true;
  try { await hub?.stop({ exitProcess: false, forceCloseConnections: true }); }
  finally { await service?.close(); app.exit(exitCode); }
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => { void stop(); });
void app.whenReady().then(async () => {
try {
  service = await startSeededOpenCode({ binary: config.binary, env: process.env, root: config.root, port: config.opencodePort, directory: config.projectDirectory,
    logFile: path.join(config.evidence, 'test-hub-opencode.log'), onStart: value => { service = value; } });
  Object.assign(process.env, service.env, { YURI_RUNTIME: 'desktop', YURI_DATA_DIR: path.join(config.root, 'yuri-data'),
    YURI_DIST_DIR: path.join(config.repo, 'packages/web/dist'), YURI_HOST: '127.0.0.1' });
  fs.mkdirSync(process.env.YURI_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.YURI_DATA_DIR, 'settings.json'), JSON.stringify({ projects: [{ id: 'ios-performance-project', path: service.directory, label: config.projectLabel ?? 'iOS performance project', addedAt: Date.now(), lastOpenedAt: Date.now() }], lastDirectory: service.directory }));
  const { startWebUiServer } = await import(pathToFileURL(path.join(config.repo, 'packages/web/server/index.js')).href);
  const origin = `http://127.0.0.1:${config.port}`;
  const descriptorInput = config.remoteDescriptorFile ? JSON.parse(fs.readFileSync(config.remoteDescriptorFile, 'utf8')) : null;
  const remoteDescriptors = descriptorInput ? descriptorInput.hosts ?? [descriptorInput.host] : [];
  if (!Array.isArray(remoteDescriptors) || remoteDescriptors.some(host => !host?.id)) throw new Error('Invalid isolated remote fixture descriptors');
  hub = await startWebUiServer({ host: '127.0.0.1', port: config.port, attachSignals: false, exitOnShutdown: false, apiOnly: false,
    ...(remoteDescriptors.length ? { remoteHostsAdapter: { listHosts: async () => remoteDescriptors.map(host => ({ ...host, name: host.label, source: host.relay ? 'relay' : 'direct' })) } } : {}),
    sessionIndexDbPath: path.join(config.root, 'session-index.sqlite'), messageQueueDbPath: path.join(config.root, 'message-queue.sqlite'),
    transcriptCacheDbPath: path.join(config.root, 'transcript-cache.sqlite'), onDesktopNotification: () => {},
    getDesktopRuntimeConfig: () => ({ apiBaseUrl: origin, requestHeaders: {} }), getIsWindowFocused: () => false });
  fs.writeFileSync(path.join(config.evidence, 'test-hub.json'), JSON.stringify({ pid: process.pid, root: config.root, origin,
    sessionId: service.sessionId, directory: service.directory, classification: 'diagnostic', source: 'real HEAD Yuri server + real isolated OpenCode', fixture: service.fixture }, null, 2));
  console.log('[ios-test-hub] ready (isolated loopback; no credentials logged)');
  let lastCommand;
  let active = false;
  const timer = setInterval(async () => {
    const control = path.join(config.root, 'control.json');
    if (active || !fs.existsSync(control)) return;
    const command = JSON.parse(fs.readFileSync(control, 'utf8'));
    if (command.id === lastCommand) return;
    lastCommand = command.id; active = true;
    const result = { id: command.id, action: command.action, startedAt: Date.now() };
    try {
      if (command.action === 'stop') { clearInterval(timer); await stop(); return; }
      if (command.action === 'inspect') {
        const response = await fetch(origin + '/api/client-auth/clients');
        const body = response.ok ? await response.json() : null;
        result.status = 'observed';
        result.httpStatus = response.status;
        result.clients = body?.clients?.map(client => ({ clientKind: client.clientKind, lastSeenAt: client.lastSeenAt }));
        return;
      }
      if (command.action !== 'pair') throw new Error('Unknown control action');
      const response = await fetch(origin + '/api/client-auth/pairing/sessions', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'Isolated iOS performance simulator', serverUrl: origin, includeRelay: false, includeDirect: true, allowedClientKinds: ['mobile'] }) });
      if (!response.ok) throw new Error(`Real Hub pairing API HTTP ${response.status}`);
      const pair = await response.json();
      const payload = { v: 2, pairingId: pair.pairing.id, secret: pair.pairing.secret, label: 'Isolated performance Hub',
        fingerprint: pair.pairing.fingerprint, expiresAt: pair.pairing.expiresAt, candidates: [{ type: 'lan', url: origin, priority: 10 }] };
      const url = `yuri://connect?v=2&p=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
      // Pairing material remains transient: no command line or URL is persisted.
      const opened = spawnSync('xcrun', ['simctl', 'openurl', config.udid, url], { encoding: 'utf8', env: process.env, timeout: 30000 });
      if (opened.status !== 0) throw new Error(`simctl openurl failed (${opened.status})`);
      result.status = 'pairing-link-delivered';
      result.limitation = 'Delivery is not proof of pairing/connected UI; verify native App and real Hub client state separately.';
    } catch (error) { result.status = 'blocked'; result.error = error.message; }
    finally {
    result.completedAt = Date.now();
    fs.appendFileSync(path.join(config.evidence, 'hub-actions.jsonl'), JSON.stringify(result) + '\n');
    active = false;
    }
  }, 250);
  setTimeout(() => { void stop(); }, 30 * 60 * 1000).unref();
} catch (error) { console.error('[ios-test-hub] failed:', error.message); await stop(2); }
});
