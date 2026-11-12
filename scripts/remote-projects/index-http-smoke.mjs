import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startSeededOpenCode } from './seeded-opencode.mjs';

const freePort = () => new Promise(resolve => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const script = fileURLToPath(import.meta.url);

if (process.argv[2] === 'worker') {
  const c = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  let opencode, server, stopping = false, modelRequests = 0;
  const modelTrap = createServer((_req, res) => {
    modelRequests++;
    res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'No model calls permitted in index smoke' }));
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = init?.method ?? input?.method ?? 'GET';
    const startedAt = Date.now();
    try {
      const response = await originalFetch(input, init);
      if (url.hostname === '127.0.0.1') {
        const entry = { startedAt, method, route: url.pathname + url.search, status: response.status };
        if (url.pathname === '/api/yuri/session-index/sync' && method === 'POST') {
          entry.body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
          entry.response = await response.clone().json();
        }
        fs.appendFileSync(path.join(c.evidence, `${c.role}-fetch.jsonl`), JSON.stringify(entry) + '\n');
      }
      return response;
    } catch (error) {
      fs.appendFileSync(path.join(c.evidence, `${c.role}-fetch.jsonl`), JSON.stringify({ startedAt, method, route: url.pathname, error: error.message }) + '\n');
      throw error;
    }
  };
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await server?.stop({ exitProcess: false, forceCloseConnections: true }); }
    finally {
      await opencode?.close();
      modelTrap.closeAllConnections(); modelTrap.close();
      fs.writeFileSync(path.join(c.evidence, `${c.role}-stopped.json`), JSON.stringify({ pid: process.pid, modelRequests, stoppedAt: Date.now() }));
      process.exit(0);
    }
  };
  process.on('message', value => { if (value === 'stop') void stop(); });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => { void stop(); });
  process.once('disconnect', () => { void stop(); });
  try {
    await new Promise(resolve => modelTrap.listen(0, '127.0.0.1', resolve));
    opencode = await startSeededOpenCode({ binary: c.binary, root: c.root, port: c.opencodePort,
      env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: ['openai'], model: 'openai/gpt-4.1', small_model: 'openai/gpt-4.1',
        provider: { openai: { options: { apiKey: 'fixture', baseURL: `http://127.0.0.1:${modelTrap.address().port}/v1` } } } }) },
      logFile: path.join(c.evidence, `${c.role}-opencode.log`), onStart: value => { opencode = value; } });
    Object.assign(process.env, opencode.env, { YURI_DATA_DIR: path.join(c.root, 'yuri-data'), YURI_RUNTIME: 'desktop' });
    fs.mkdirSync(process.env.YURI_DATA_DIR);
    fs.writeFileSync(path.join(process.env.YURI_DATA_DIR, 'settings.json'), JSON.stringify({ projects: [] }));
    const { startWebUiServer } = await import(pathToFileURL(path.join(c.repo, 'packages/web/server/index.js')).href);
    server = await startWebUiServer({ host: '127.0.0.1', port: c.port, apiOnly: true, attachSignals: false, exitOnShutdown: false,
      remoteHostsAdapter: { listHosts: async () => c.remote ? [{ ...c.remote, source: 'direct', name: 'Isolated index remote' }] : [] } });
    process.send({ ready: true, pid: process.pid, origin: `http://127.0.0.1:${c.port}`, opencodePort: c.opencodePort,
      sessionId: opencode.sessionId, directory: fs.realpathSync(opencode.directory), abi: process.versions.modules });
    setTimeout(() => { void stop(); }, 180000).unref();
  } catch (error) { process.send?.({ error: error.message }); await stop(); }
} else {
  const repo = process.cwd();
  const evidence = path.resolve('.scratch/remote-projects/performance/index-http-smoke');
  fs.mkdirSync(evidence, { recursive: true });
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR, 'opencode/remote-index-http-'));
  const inventory = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? inventory(path.join(dir, e.name)) : e.isFile() ? [path.join(dir, e.name)] : []);
  const source = () => {
    const files = [...inventory(path.join(repo, 'packages/web/server')), path.join(repo, 'packages/web/package.json'), path.join(repo, 'bun.lock')].sort()
      .map(file => ({ file: path.relative(repo, file), sha256: hash(fs.readFileSync(file)) }));
    return { observedAt: new Date().toISOString(), scope: 'packages/web/server/** + packages/web/package.json + bun.lock; direct current backend, not whole UI candidate',
      sourceHash: hash(files.map(f => `${f.file}\0${f.sha256}\0`).join('')), files };
  };
  const before = source();
  fs.writeFileSync(path.join(evidence, 'source-before.json'), JSON.stringify(before, null, 2));
  const require = createRequire(path.join(repo, 'packages/web/package.json'));
  const Database = require('better-sqlite3');
  const db = new Database(':memory:'); db.prepare('select 1').get(); db.close();
  const children = [], controllers = [], readers = [];
  const report = { classification: 'real HTTP/SSE backend diagnostic; no UI or budget verdict', root, sourceHash: before.sourceHash,
    node: process.version, abi: process.versions.modules, nativeProbe: 'existing better-sqlite3 binding works; no rebuild/install', steps: [] };
  const save = () => fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
  const request = async (origin, route, token, method = 'GET', body) => {
    const response = await fetch(origin + route, { method, headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(15000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, body: data };
  };
  const launch = async (role, remote) => {
    const directory = path.join(root, role); fs.mkdirSync(directory);
    for (const name of ['home', 'config', 'data', 'cache', 'project']) fs.mkdirSync(path.join(directory, name));
    const config = { repo, evidence, role, root: directory, remote, binary: process.argv[2] ?? path.join(process.env.HOME, '.opencode/bin/opencode'), port: await freePort(), opencodePort: await freePort() };
    const configFile = path.join(directory, 'worker.json'); fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
    const log = fs.openSync(path.join(evidence, `${role}-server.log`), 'w');
    const child = fork(script, ['worker', configFile], { cwd: path.join(directory, 'project'),
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: path.join(directory, 'home'), XDG_CONFIG_HOME: path.join(directory, 'config'),
        XDG_DATA_HOME: path.join(directory, 'data'), XDG_CACHE_HOME: path.join(directory, 'cache'), NODE_ENV: 'production' }, stdio: ['ignore', log, log, 'ipc'] });
    fs.closeSync(log); children.push(child);
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${role} readiness timeout`)), 60000);
      child.on('message', message => {
        if (message?.ready !== true && !message?.error) return;
        clearTimeout(timer); message.ready ? resolve(message) : reject(new Error(message.error));
      });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`${role} exited before readiness`)); });
    });
    report[role] = ready; save(); return ready;
  };
  const stream = async (label, origin, route, token) => {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(origin + route, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
    if (!response.ok) throw new Error(`${label} stream HTTP ${response.status}`);
    const chunks = [];
    readers.push((async () => {
      try { for await (const bytes of response.body) { const text = Buffer.from(bytes).toString(); chunks.push(text); fs.appendFileSync(path.join(evidence, `${label}-sse.txt`), text); } }
      catch (error) { if (!controller.signal.aborted) report[`${label}StreamError`] = error.message; }
    })());
    return chunks;
  };
  const must = (condition, message) => { if (!condition) throw new Error(message); };
  try {
    const remote = await launch('remote');
    const created = await request(remote.origin, '/api/client-auth/clients', null, 'POST', { label: 'Isolated HTTP index Hub', clientKind: 'desktop' });
    must(created.status === 201 && created.body.token, `remote credential issuance failed HTTP ${created.status}`);
    const remoteToken = created.body.token;
    report.unauthenticatedCapabilities = await request(remote.origin, '/api/hosts/capabilities');
    report.capabilities = await request(remote.origin, '/api/hosts/capabilities', remoteToken);
    must(report.unauthenticatedCapabilities.status === 401 && report.capabilities.body.protocol === 1, 'auth/capability contract failed');
    report.remoteBefore = await request(remote.origin, '/api/yuri/session-index', remoteToken);
    await stream('remote', remote.origin, '/api/hosts/status-stream', remoteToken);
    const hub = await launch('hub', { id: 'index-remote', apiUrl: remote.origin, url: remote.origin, clientToken: remoteToken });
    const paired = await request(hub.origin, '/api/client-auth/pairing/sessions', null, 'POST', { includeRelay: false, includeDirect: true, allowedClientKinds: ['desktop'] });
    must(paired.status === 201 && paired.body.pairing?.secret, `Hub pairing creation failed HTTP ${paired.status}`);
    const grant = await request(hub.origin, '/api/client-auth/pairing/redeem', null, 'POST', { pairingId: paired.body.pairing.id, secret: paired.body.pairing.secret,
      clientKind: 'desktop', clientLabel: 'Isolated HTTP observer', dedupeKey: 'index-http' });
    must(grant.status === 200 && grant.body.clientToken, 'Hub pairing redemption failed');
    const hubToken = grant.body.clientToken;
    const hubEvents = await stream('hub', hub.origin, '/api/global/event', hubToken);
    report.catalog = await request(hub.origin, '/api/hosts', hubToken);
    report.worktrees = await request(remote.origin, '/api/git/worktrees?directory=' + encodeURIComponent(remote.directory), remoteToken);
    report.addProject = await request(hub.origin, '/api/hosts/index-remote/projects', hubToken, 'POST', { path: remote.directory, label: 'Index HTTP imported project' });
    must(report.addProject.status === 200, 'Add remote project failed');
    save();
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      report.summary = await request(hub.origin, '/api/hosts/index-remote/summaries', hubToken);
      if (JSON.stringify(report.summary.body).includes(remote.sessionId)) break;
      await delay(500);
    }
    report.remoteAfter = await request(remote.origin, '/api/yuri/session-index', remoteToken);
    report.session = await request(hub.origin, `/api/hosts/index-remote/api/session/${remote.sessionId}?directory=${encodeURIComponent(remote.directory)}`, hubToken);
    report.messages = await request(hub.origin, `/api/hosts/index-remote/api/session/${remote.sessionId}/message?directory=${encodeURIComponent(remote.directory)}`, hubToken);
    report.legacyStatus = await request(hub.origin, '/api/hosts/index-remote/api/session/status?directory=' + encodeURIComponent(remote.directory), hubToken);
    report.status = await request(hub.origin, '/api/hosts/index-remote/api/session/active', hubToken);
    report.forms = await request(hub.origin, '/api/hosts/index-remote/api/form?directory=' + encodeURIComponent(remote.directory), hubToken);
    await delay(1000);
    report.hubRevisionEventObserved = hubEvents.join('').includes('session-index');
    const audit = fs.readFileSync(path.join(evidence, 'hub-fetch.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    report.automaticSyncRequests = audit.filter(x => x.method === 'POST' && x.route === '/api/yuri/session-index/sync');
    must(report.summary.status === 200 && JSON.stringify(report.summary.body).includes(remote.sessionId), 'Imported session missing from Hub summary; inspect remoteAfter.sync.failedDirectories and remote-server.log');
    must(report.session.status === 200 && JSON.stringify(report.session.body).includes(remote.sessionId), 'Existing session read failed');
    must(report.messages.status === 200 && (report.messages.body.data ?? report.messages.body).length === 20, 'Expected 20 real imported messages');
    must(report.status.status === 200, 'Session status API failed');
    must(report.forms.status === 200, 'Project forms API failed');
    must(report.automaticSyncRequests.some(x => x.body?.directories?.includes(remote.directory) && x.status === 202), 'No successful automatic Gateway sync request observed');
    report.outcome = 'passed-real-http-summary-session-message-status-form';
  } catch (error) { report.outcome = 'failed'; report.error = error.message; process.exitCode = 2; }
  finally {
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(readers);
    for (const child of [...children].reverse()) {
      if (child.exitCode === null) {
        child.send('stop');
        await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(10000)]);
        if (child.exitCode === null) child.kill('SIGTERM');
      }
    }
    const after = source(); report.sourceUnchanged = before.sourceHash === after.sourceHash;
    fs.writeFileSync(path.join(evidence, 'source-after.json'), JSON.stringify(after, null, 2));
    report.cleanup = children.map(child => ({ pid: child.pid, exited: child.exitCode !== null || child.signalCode !== null }));
    save(); console.log(JSON.stringify({ outcome: report.outcome, error: report.error, sourceHash: before.sourceHash, sourceUnchanged: report.sourceUnchanged, evidence }));
  }
}
