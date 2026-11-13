import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createServer } from 'node:http';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const here = fileURLToPath(import.meta.url);
const sourceHashes = async () => Object.fromEntries(await Promise.all([
  'packages/web/server/index.js', 'packages/web/server/lib/remote-hosts/gateway.js',
  'packages/web/server/lib/remote-hosts/routes.js', 'packages/web/server/lib/remote-hosts/transport.js',
].map(async filename => [filename, crypto.createHash('sha256').update(await fs.readFile(new URL(`../${filename}`, import.meta.url))).digest('hex')])));
const quantiles = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
  return { count: sorted.length, p50: at(.5), p95: at(.95), max: at(1) };
};

if (process.argv.includes('--hub-worker')) {
  const config = await new Promise(resolve => process.once('message', resolve));
  for (const key of Object.keys(process.env)) if (/^(YURI_|OPENCODE_)/.test(key)) delete process.env[key];
  Object.assign(process.env, {
    HOME: config.root, XDG_CONFIG_HOME: path.join(config.root, 'config'),
    XDG_DATA_HOME: path.join(config.root, 'data'), XDG_STATE_HOME: path.join(config.root, 'state'),
    YURI_DATA_DIR: path.join(config.root, 'hub'), YURI_RUNTIME: 'desktop',
    YURI_SKIP_OPENCODE_START: 'true', OPENCODE_HOST: config.upstream,
    NODE_ENV: 'development', YURI_WEIXIN_ENABLED: '0', YURI_CHANNELS_ENABLED: '0',
  });
  const { createRemoteClientAuthRuntime } = await import('../packages/web/server/lib/client-auth/remote-clients.js');
  const clients = createRemoteClientAuthRuntime({ fsPromises: fs, path, crypto,
    storePath: path.join(config.root, 'hub', 'remote-clients.json') });
  const { token } = await clients.createClient({ label: 'Isolated acceptance', clientKind: 'desktop-local' });
  const loadedSourceHashes = await sourceHashes();
  const { startWebUiServer } = await import('../packages/web/server/index.js');
  const hub = await startWebUiServer({ port: 0, host: '127.0.0.1', apiOnly: true,
    attachSignals: false, exitOnShutdown: false,
    remoteHostsAdapter: { listHosts: async () => config.hosts } });
  let previousCpu = process.cpuUsage();
  let previousTime = process.hrtime.bigint();
  const timer = setInterval(() => {
    const time = process.hrtime.bigint(); const cpu = process.cpuUsage();
    const wallUs = Number(time - previousTime) / 1000;
    const userUs = cpu.user - previousCpu.user; const systemUs = cpu.system - previousCpu.system;
    process.send({ kind: 'sample', timestamp: new Date().toISOString(), monotonicMs: Number(time) / 1e6,
      pid: process.pid, wallUs, userUs, systemUs, cpuOneCorePercent: 100 * (userUs + systemUs) / wallUs,
      rssBytes: process.memoryUsage().rss, totalUserUs: cpu.user, totalSystemUs: cpu.system });
    previousCpu = cpu; previousTime = time;
  }, 1000);
  process.send({ kind: 'ready', origin: `http://127.0.0.1:${hub.getPort()}`, token, loadedSourceHashes });
  process.on('message', async message => {
    if (message?.kind !== 'stop') return;
    clearInterval(timer);
    await hub.stop({ exitProcess: false, forceCloseConnections: true });
    process.exit(0);
  });
} else {
  const quick = process.argv.includes('--quick');
  const connectedOnly = process.argv.includes('--connected-only');
  const faultOnly = process.argv.includes('--fault-only');
  const idleSeconds = quick ? 2 : connectedOnly || faultOnly ? 0 : 600; const measurementMs = quick ? 2000 : 30000;
  const output = path.resolve(process.argv[2] || `.scratch/remote-projects/gateway-evidence/${new Date().toISOString().replaceAll(':', '-')}`);
  await fs.mkdir(output, { recursive: true });
  const temporaryBase = path.join(os.tmpdir(), 'opencode');
  await fs.mkdir(temporaryBase, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporaryBase, 'remote-hosts-acceptance-'));
  const raw = createWriteStream(path.join(output, 'samples.jsonl'));
  const childLog = createWriteStream(path.join(output, 'hub.log'));
  let phase = 'setup'; const samples = []; const checks = []; const fixtures = [];
  let child; let closed = false; let readStream; let eventTail = '';
  const record = value => raw.write(`${JSON.stringify({ timestamp: new Date().toISOString(), phase, ...value })}\n`);
  const check = (name, passed, detail) => { checks.push({ name, passed, detail }); record({ kind: 'check', name, passed, detail }); };
  const fixture = async index => {
    const token = crypto.randomUUID(); const projects = new Map(); const streams = new Set();
    const state = { id: `host-${index}`, requests: 0, requestsByPath: {}, statusStarts: 0,
      statusActive: 0, statusMax: 0, contentStarts: 0, contentActive: 0, stallUntil: 0, revision: 0 };
    const server = createServer(async (req, res) => {
      const pathname = new URL(req.url, 'http://fixture.invalid').pathname;
      state.requests++; state.requestsByPath[pathname] = (state.requestsByPath[pathname] || 0) + 1;
      record({ kind: 'upstream-request', hostId: state.id, method: req.method, pathname });
      const reply = (status, value) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); } };
      if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: 'unauthorized' });
      if (pathname === '/api/hosts/capabilities') return reply(200, { remoteProjects: true, protocol: 1, instanceId: state.id, version: 'acceptance-fixture' });
      if (pathname === '/api/projects' && req.method === 'POST') {
        let text = ''; for await (const chunk of req) text += chunk;
        const input = JSON.parse(text); const previous = projects.get(input.path);
        const project = previous || { id: `project-${index}`, path: input.path, label: state.id };
        projects.set(input.path, project); return reply(200, { project, created: !previous });
      }
      if (pathname === '/api/projects') return reply(200, { projects: [...projects.values()] });
      if (pathname === '/api/hosts/status-stream' || pathname === '/api/event') {
        const status = pathname.endsWith('status-stream');
        if (status) { state.statusStarts++; state.statusActive++; state.statusMax = Math.max(state.statusMax, state.statusActive); }
        else { state.contentStarts++; state.contentActive++; }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        res.write(': ready\n\n'); streams.add(res);
        const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 1000);
        res.once('close', () => { clearInterval(heartbeat); streams.delete(res); if (status) state.statusActive--; else state.contentActive--; });
        if (!status) res.write(`data: ${JSON.stringify({ directory: '/workspace/shared', payload: {
          type: 'message.part.delta', properties: { sessionID: 'same-session', delta: `REMOTE_BODY_CANARY_${index}` } } })}\n\n`);
        return;
      }
      if (pathname === '/api/fs/raw' || pathname === '/api/yuri/session-index' || pathname === '/api/session/same-session/message') {
        const delay = state.stallUntil - Date.now(); if (delay > 0) await sleep(delay);
        if (pathname !== '/api/yuri/session-index') return reply(200, { hostId: state.id, body: `REMOTE_BODY_CANARY_${index}` });
        return reply(200, { directories: [{ directory: '/workspace/shared', sessions: [{ id: 'same-session',
          directory: '/workspace/shared', title: state.revision ? `Summary ${index} revision ${state.revision}` : `Summary ${index}`, time: { created: 1, updated: 2 } }], hasMore: false }], pinnedSessionIds: [] });
      }
      if (pathname === '/api/yuri/session-unread') return reply(200, { revision: 0, sessions: {} });
      if (pathname === '/api/session-folders') return reply(200, { version: 1, foldersMap: {}, collapsedFolderIds: [] });
      if (pathname === '/api/session-folders/order') return reply(200, { revision: 0, sessionOrderByScope: {}, sessionOrderActivityByScope: {} });
      return reply(404, { error: 'unsupported_fixture_route' });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { state, server, descriptor: { id: state.id, name: state.id, source: 'direct', clientToken: token,
      apiUrl: `http://127.0.0.1:${server.address().port}` },
      tip() { for (const stream of streams) stream.write(`data: ${JSON.stringify({ directory: 'global', payload: {
        type: 'yuri:session-index-changed', properties: { cause: 'change' } } })}\n\n`); } };
  };
  const localUpstreamState = { requests: 0, activeStreams: 0 };
  const upstream = createServer((req, res) => {
    localUpstreamState.requests++;
    if (['/api/event', '/api/global/event'].includes(new URL(req.url, 'http://local.invalid').pathname)) {
      localUpstreamState.activeStreams++;
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n');
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 1000);
      res.once('close', () => { clearInterval(heartbeat); localUpstreamState.activeStreams--; });
      return;
    }
    res.writeHead(req.url === '/api/info' || req.url === '/health' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: '2.2.1', healthy: true }));
  });
  const wait = async predicate => {
    const deadline = Date.now() + 15000;
    while (!await predicate()) { assert.ok(Date.now() < deadline, 'condition timeout'); await sleep(50); }
  };
  let result = { quickPreflightOnly: quick, mode: connectedOnly ? 'connected-only' : faultOnly ? 'fault-only' : 'full',
    measurementEnvironment: { logicalCpuCount: os.cpus().length, startLoadAverage: os.loadavg() },
    boundary: 'real production startWebUiServer; separate Hub child process; five synthetic direct loopback origins',
    limitations: ['not real Relay/SSH/WAN', 'no Electron renderer or Capacitor UI', 'parallel compilation/system load is uncontrolled',
      'CPU is Hub process user+system microseconds divided by monotonic wall time, 100%=one core; child processes excluded',
      'RSS is process.memoryUsage().rss, not heap or whole application process-tree memory', 'fixture counters exclude the separate synthetic local OpenCode origin'] };
  try {
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    for (let i = 0; i < 5; i++) fixtures.push(await fixture(i));
    child = fork(here, ['--hub-worker'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.once('exit', () => { closed = true; });
    child.stdout.pipe(childLog, { end: false }); child.stderr.pipe(childLog, { end: false });
    await fs.writeFile(path.join(output, 'pids.json'), JSON.stringify({ orchestrator: process.pid, hub: child.pid, startedAt: new Date().toISOString() }, null, 2));
    child.on('message', message => { if (message.kind === 'sample') { const sample = { ...message, phase }; samples.push(sample); record(sample); } });
    const ready = new Promise((resolve, reject) => {
      child.on('message', message => { if (message.kind === 'ready') resolve(message); });
      child.once('exit', code => reject(new Error(`Hub exited before ready: ${code}`)));
    });
    child.send({ root, hosts: fixtures.map(f => f.descriptor), upstream: `http://127.0.0.1:${upstream.address().port}` });
    const { origin, token, loadedSourceHashes } = await ready;
    result.loadedSourceHashes = loadedSourceHashes;
    const call = (route, init = {}) => fetch(`${origin}${route}`, { ...init, signal: init.signal || AbortSignal.timeout(40000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...init.headers } });
    const openStream = async () => {
      const controller = new AbortController(); const response = await call('/api/global/event', { signal: controller.signal });
      assert.equal(response.status, 200);
      const done = (async () => { try { for await (const chunk of response.body) {
        const text = new TextDecoder().decode(chunk); eventTail = (eventTail + text).slice(-65536); record({ kind: 'hub-event', text });
      } } catch { /* Owned stream cancellation. */ } })();
      return { async close() { controller.abort(); await done; } };
    };
    await sleep(3000);
    check('zero-reference production startup adds no remote requests', fixtures.every(f => f.state.requests === 0));
    if (connectedOnly) {
      phase = 'memory-zero-hosts'; readStream = await openStream(); await sleep(3000);
      result.memorySequentialSteps = [{ hosts: 0, rssBytes: samples.at(-1)?.rssBytes }];
      result.limitations.push('sequential per-Host RSS deltas include cold project/index/transport setup and GC/allocator effects; not isolated retained subscription allocations');
    }
    for (const f of fixtures) {
      assert.equal((await call(`/api/hosts/${f.state.id}/projects`, { method: 'POST', body: JSON.stringify({ path: '/workspace/shared' }) })).status, 200);
      if (connectedOnly) {
        await wait(() => f.state.statusActive === 1); await sleep(2000);
        const previous = result.memorySequentialSteps.at(-1);
        const rssBytes = samples.at(-1)?.rssBytes;
        result.memorySequentialSteps.push({ hosts: previous.hosts + 1, rssBytes, deltaBytes: rssBytes - previous.rssBytes });
      }
    }
    phase = 'five-host-subscriptions'; readStream ||= await openStream();
    await wait(() => fixtures.every(f => f.state.statusActive === 1));
    const secondStream = await openStream();
    await sleep(3000);
    check('five Hosts share exactly one status subscription each with two Hub clients', fixtures.every(f => f.state.statusActive === 1 && f.state.statusMax === 1), fixtures.map(f => structuredClone(f.state)));
    for (let i = 0; i < 5; i++) {
      const lease = await call(`/api/hosts/host-${i}/subscriptions`, { method: 'POST', body: JSON.stringify({ directory: '/workspace/shared', sessionId: 'same-session' }) });
      assert.equal(lease.status, 200);
      const content = await (await call(`/api/hosts/host-${i}/api/fs/raw`)).json();
      assert.equal(content.hostId, `host-${i}`);
      await wait(async () => (await (await call(`/api/hosts/host-${i}/summaries`)).json()).directories[0]?.sessions[0]?.title === `Summary ${i}`);
    }
    check('same directory/session identity routes to five distinct origins and summary partitions', true);
    await wait(() => fixtures.every((_, i) => eventTail.includes(`REMOTE_BODY_CANARY_${i}`)));
    check('five remote message delta canaries cross the real production SSE proxy', true);
    await secondStream.close(); await readStream.close(); readStream = null;
    await wait(() => fixtures.every(f => f.state.statusActive === 0 && f.state.contentActive === 0));
    const counters = fixtures.map(f => f.state.requests);
    check('last client releases all status and content subscriptions', true, fixtures.map(f => structuredClone(f.state)));
    phase = 'no-clients-600s';
    const idleStart = performance.now();
    for (let elapsed = 0; elapsed < idleSeconds; elapsed++) {
      await sleep(1000);
      record({ kind: 'counter', elapsedMs: performance.now() - idleStart, loadAverage: os.loadavg(), hosts: fixtures.map(f => ({ ...f.state })) });
    }
    const idleSamples = samples.filter(s => s.phase === phase).slice(1, 301);
    result.noClients = { wallMs: performance.now() - idleStart, requestDeltas: fixtures.map((f, i) => f.state.requests - counters[i]),
      finalCounters: fixtures.map(f => structuredClone(f.state)), localOpenCodeOrigin: { ...localUpstreamState } };
    check(`${idleSeconds} seconds with persisted references and no clients adds zero remote requests/subscriptions`, fixtures.every((f, i) => f.state.requests === counters[i] && f.state.statusActive === 0 && f.state.contentActive === 0), result.noClients);
    result.idle = { cpuOneCorePercent: quantiles(idleSamples.map(s => s.cpuOneCorePercent)), rssBytes: quantiles(idleSamples.map(s => s.rssBytes)),
      weightedCpuOneCorePercent: 100 * idleSamples.reduce((sum, s) => sum + s.userUs + s.systemUs, 0) / idleSamples.reduce((sum, s) => sum + s.wallUs, 0),
      wallMs: idleSamples.reduce((sum, s) => sum + s.wallUs / 1000, 0), samples: idleSamples.length };
    readStream = await openStream(); await wait(() => fixtures.every(f => f.state.statusActive === 1));
    if (connectedOnly) {
      await sleep(3000);
      const indexCounts = fixtures.map(f => f.state.requestsByPath['/api/yuri/session-index'] || 0);
      const initialRss = samples.at(-1)?.rssBytes;
      phase = 'five-hosts-connected-idle-300s';
      const began = performance.now();
      for (let i = 0; i < (quick ? 2 : 301); i++) {
        await sleep(1000);
        record({ kind: 'counter', elapsedMs: performance.now() - began, loadAverage: os.loadavg(), hosts: fixtures.map(f => structuredClone(f.state)) });
      }
      const connectedSamples = samples.filter(s => s.phase === phase).slice(1, 301);
      result.connectedIdle = { cpuOneCorePercent: quantiles(connectedSamples.map(s => s.cpuOneCorePercent)),
        rssBytes: quantiles(connectedSamples.map(s => s.rssBytes)), initialRss,
        weightedCpuOneCorePercent: 100 * connectedSamples.reduce((sum, s) => sum + s.userUs + s.systemUs, 0) / connectedSamples.reduce((sum, s) => sum + s.wallUs, 0),
        wallMs: connectedSamples.reduce((sum, s) => sum + s.wallUs / 1000, 0), samples: connectedSamples.length,
        indexRequestDeltas: fixtures.map((f, i) => (f.state.requestsByPath['/api/yuri/session-index'] || 0) - indexCounts[i]) };
      check('five idle Hosts retain one status stream each and do not periodically rescan indexes', fixtures.every((f, i) => f.state.statusActive === 1 && (f.state.requestsByPath['/api/yuri/session-index'] || 0) === indexCounts[i]), result.connectedIdle);
      if (!quick) check('five idle connected Hosts have weighted one-core CPU below 0.5 percent over 300 samples',
        result.connectedIdle.samples === 300 && result.connectedIdle.wallMs >= 300000 && result.connectedIdle.weightedCpuOneCorePercent < .5, result.connectedIdle);
    }
    if (!connectedOnly) {
    const measure = async (name, onTick = () => {}) => {
      phase = name; const measurements = []; const refreshes = []; const start = performance.now(); let index = 0;
      while (performance.now() - start < measurementMs) {
        const hostId = `host-${1 + index++ % 4}`; const began = performance.now();
        const response = await call(`/api/hosts/${hostId}/api/fs/raw`); const body = await response.json();
        const sample = { kind: 'latency', hostId, elapsedMs: performance.now() - began, status: response.status, correctOrigin: body.hostId === hostId };
        measurements.push(sample); record(sample); onTick();
        const remote = fixtures.find(f => f.state.id === hostId);
        const revision = ++remote.state.revision; const refreshStart = performance.now(); remote.tip();
        let fresh = false;
        while (performance.now() - refreshStart < 35000) {
          const snapshot = await (await call(`/api/hosts/${hostId}/summaries`)).json();
          if (snapshot.directories[0]?.sessions[0]?.title === `Summary ${Number(hostId.split('-')[1])} revision ${revision}`) { fresh = true; break; }
          await sleep(5);
        }
        const refreshSample = { kind: 'index-freshness', hostId, revision, fresh, elapsedMs: performance.now() - refreshStart };
        refreshes.push(refreshSample); record(refreshSample);
        await sleep(Math.max(0, 100 - (performance.now() - began)));
      }
      return { elapsedMs: quantiles(measurements.map(m => m.elapsedMs)), indexFreshnessMs: quantiles(refreshes.map(m => m.elapsedMs)),
        perHost: Object.fromEntries(fixtures.slice(1).map(f => [f.state.id, { requestMs: quantiles(measurements.filter(m => m.hostId === f.state.id).map(m => m.elapsedMs)), indexFreshnessMs: quantiles(refreshes.filter(m => m.hostId === f.state.id).map(m => m.elapsedMs)) }])),
        failures: measurements.filter(m => m.status !== 200 || !m.correctOrigin).length + refreshes.filter(m => !m.fresh).length };
    };
    result.baseline = await measure('baseline-30s');
    fixtures[0].state.stallUntil = Date.now() + measurementMs;
    fixtures[0].tip();
    const stalledStart = performance.now();
    const stallRoute = '/api/session/same-session/message';
    const rawBefore = fixtures[0].state.requestsByPath[stallRoute] || 0;
    const stalled = call(`/api/hosts/host-0${stallRoute}`).then(async response => ({ status: response.status, body: await response.json(), elapsedMs: performance.now() - stalledStart }));
    await wait(() => fixtures[0].state.requestsByPath[stallRoute] > rawBefore);
    const indexBefore = fixtures.slice(1).map(f => f.state.requestsByPath['/api/yuri/session-index'] || 0);
    const firstRefreshMs = [null, null, null, null];
    for (const f of fixtures.slice(1)) f.tip();
    result.fault = await measure('fault-host-0-stalled-30s', () => {
      fixtures.slice(1).forEach((f, i) => {
        if (firstRefreshMs[i] === null && f.state.requestsByPath['/api/yuri/session-index'] > indexBefore[i]) firstRefreshMs[i] = performance.now() - stalledStart;
      });
    });
    result.stalledRequest = await stalled;
    result.faultRefreshProgress = { firstRefreshMs, indexBefore, indexAfter: fixtures.slice(1).map(f => f.state.requestsByPath['/api/yuri/session-index'] || 0) };
    check(`one Host fixture stalls ${measurementMs / 1000}s without wrong-origin or failed healthy Host requests`, result.fault.failures === 0, { baseline: result.baseline, fault: result.fault, stalledRequest: { status: result.stalledRequest.status, elapsedMs: result.stalledRequest.elapsedMs } });
    if (!quick) check('response-header deadline releases priority and all four healthy refreshes resume before the 30s fixture stall ends',
      result.stalledRequest.status === 503 && result.stalledRequest.elapsedMs < 29000 && firstRefreshMs.every(ms => ms !== null && ms < 29000), result.faultRefreshProgress);
    result.p95Regression = { requestPercent: 100 * (result.fault.elapsedMs.p95 / result.baseline.elapsedMs.p95 - 1),
      indexFreshnessPercent: 100 * (result.fault.indexFreshnessMs.p95 / result.baseline.indexFreshnessMs.p95 - 1) };
    check('synthetic healthy Host request and index freshness P95 regression is at most 10 percent',
      result.p95Regression.requestPercent <= 10 && result.p95Regression.indexFreshnessPercent <= 10, result.p95Regression);
    }
    await readStream.close(); readStream = null;
    phase = 'shutdown'; child.send({ kind: 'stop' }); await once(child, 'exit');
    const require = createRequire(new URL('../packages/web/package.json', import.meta.url)); const Database = require('better-sqlite3');
    const databases = [];
    for (const name of ['remote-hosts.sqlite', 'session-index.sqlite']) {
      const filename = path.join(root, 'hub', name); const db = new Database(filename, { readonly: true });
      const schema = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table'").all();
      const tables = schema.map(({ name: table }) => ({ name: table, rows: db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all() }));
      db.close();
      const serialized = JSON.stringify(tables);
      databases.push({ name, schema, tables });
      check(`${name} contains no remote message canary or message/parts table`, !serialized.includes('REMOTE_BODY_CANARY_') && !schema.some(t => /message|parts|transcript/i.test(t.name)));
      await fs.copyFile(filename, path.join(output, name));
    }
    await fs.writeFile(path.join(output, 'database-inspection.json'), JSON.stringify(databases, null, 2));
    const diskFiles = [];
    const inspectFiles = async directory => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) await inspectFiles(filename);
        else if (entry.isFile()) {
          const bytes = await fs.readFile(filename);
          diskFiles.push({ path: path.relative(path.join(root, 'hub'), filename), bytes: bytes.length,
            containsRemoteBodyCanary: bytes.includes(Buffer.from('REMOTE_BODY_CANARY_')) });
        }
      }
    };
    await inspectFiles(path.join(root, 'hub'));
    result.diskCanaryInspection = diskFiles;
    check('all files in the isolated Hub data directory are free of remote body canaries after shutdown', diskFiles.every(f => !f.containsRemoteBodyCanary));
    result.finishedSourceHashes = await sourceHashes();
    result.sourceChangedDuringRun = JSON.stringify(result.loadedSourceHashes) !== JSON.stringify(result.finishedSourceHashes);
    result.checks = checks; result.passed = checks.every(c => c.passed);
  } catch (error) {
    result.passed = false; result.error = { name: error.name, message: error.message, stack: error.stack }; result.checks = checks;
  } finally {
    await readStream?.close();
    if (child && !closed) {
      child.send({ kind: 'stop' });
      await Promise.race([once(child, 'exit'), sleep(15000)]);
      if (!closed) child.kill('SIGTERM');
    }
    for (const f of fixtures) { f.server.closeAllConnections(); await new Promise(resolve => f.server.close(resolve)); }
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    raw.end(); childLog.end();
    await fs.rm(root, { recursive: true, force: true });
    console.log(JSON.stringify({ output, passed: result.passed, error: result.error }));
    process.exit(result.passed ? 0 : 1);
  }
}
